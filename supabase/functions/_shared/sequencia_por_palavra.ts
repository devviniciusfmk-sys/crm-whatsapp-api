import type { OrganizationExtra } from "./types/extra_types.ts";
import type { FilePart, OutgoingMessage } from "./types/message_types.ts";

/**
 * # A sequência que dispara por palavra
 *
 * A barbearia monta uma sequência — áudio dos preços, foto da tabela — e diz
 * quais palavras a chamam. Quando o cliente escreve "quanto custa o corte?", a
 * sequência sai sozinha.
 *
 * ## Por que a comparação é frouxa de propósito
 *
 * Quem escreve no WhatsApp escreve "quanto custa", "Quanto custa?", "qnto
 * custa" e "quanto custa o corte". Exigir igualdade seria um gatilho que nunca
 * dispara, e o dono da loja concluiria que o recurso não funciona.
 *
 * Então: sem acento, sem maiúscula, e a palavra tem de APARECER na mensagem.
 * "preço" casa com "qual o preço?" e também com "preço bom, valeu" — o falso
 * positivo existe e é o lado barato do erro, porque o outro lado é o recurso
 * não servir para nada.
 *
 * ## O que ela NÃO faz
 *
 * Não decide se a sequência deve sair — só diz qual casou. Quem decide é
 * `agent-client`, com a trava que a tela promete: uma vez por conversa. E lá
 * a sequência tem precedência sobre o assistente, porque ela É a resposta
 * daquele turno: casou a palavra, o modelo nem é chamado.
 *
 * - 2026/08/18
 */

/** Sem acento, sem maiúscula, sem espaço sobrando. */
export function normalizar(texto: string) {
  return texto
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export type Sequencia = NonNullable<OrganizationExtra["quick_combos"]>[number];

/**
 * A primeira sequência cujo gatilho aparece na mensagem, ou nada.
 *
 * A primeira e não "a que mais casa": duas sequências com a mesma palavra é um
 * erro de quem montou, e escolher a mais longa esconderia esse erro atrás de
 * um comportamento que ninguém consegue prever. A ordem da lista é a ordem da
 * biblioteca, que é onde se resolve.
 */
export function sequenciaPara(
  mensagem: string,
  sequencias: Sequencia[] | undefined,
): Sequencia | null {
  const texto = normalizar(mensagem);

  if (!texto) return null;

  for (const sequencia of sequencias ?? []) {
    for (const gatilho of sequencia.gatilhos ?? []) {
      const palavra = normalizar(gatilho);

      // Gatilho vazio casaria com tudo. A tela já os filtra ao gravar; esta é
      // a segunda tranca, porque o dado pode ter vindo de outro lugar.
      if (palavra && texto.includes(palavra)) return sequencia;
    }
  }

  return null;
}

/**
 * Abaixo disto, quem manda ESPERA; daqui para cima, agenda.
 *
 * Mesmo número da tela (`ESPERA_NO_ENVIO` em `utils/prontos.ts`). A varredura
 * que entrega hora futura roda de minuto em minuto, então trinta segundos
 * agendados viraria "algum momento no próximo minuto".
 *
 * Divergir dos dois lados seria a tela prometer trinta segundos e o gatilho
 * por palavra entregar num minuto — o mesmo campo, dois comportamentos.
 */
export const ESPERA_NO_ENVIO = 60;

/**
 * As mensagens de uma sequência, cada uma com a hora e quanto dormir antes.
 *
 * Pausa curta volta em `dormir`, para quem chamou esperar de verdade; pausa
 * longa entra no carimbo de `quando` e é a varredura que entrega.
 *
 * Devolve o conteúdo e nada mais: quem insere é quem chamou, que é onde estão
 * os dados da conversa.
 */
export function passosComHora(
  sequencia: Sequencia,
  catalogo: {
    frases: { name: string; text: string }[];
    midias: {
      uri: string;
      name: string;
      mime_type: string;
      size: number;
      kind: FilePart["kind"];
    }[];
  },
  agora = new Date(),
) {
  // `OutgoingMessage` e não objeto solto: esta função monta o que vai ao
  // cliente, e dizer isso deixa o compilador conferir cada passo montado aqui.
  // Enquanto era `Record<string, unknown>`, quem inseria precisava de um cast —
  // e o cast estava largo demais, o que só apareceu na CI. - 2026/08/19
  const saida: {
    content: OutgoingMessage;
    /** Nulo quando não se agenda: aí quem carimba é o banco, na inserção. */
    quando: Date | null;
    /** Segundos que quem manda deve esperar ANTES de gravar este passo. */
    dormir: number;
  }[] = [];

  let atraso = 0;

  for (const passo of sequencia.steps ?? []) {
    const pausa = passo.esperar ?? 0;

    // A curta vira espera de quem manda (o campo `esperar` volta junto, para
    // quem chamou saber quanto dormir); a longa entra no carimbo.
    if (pausa >= ESPERA_NO_ENVIO) atraso += pausa;

    /**
     * Sem carimbo quando ninguém agenda: o banco carimba na inserção.
     *
     * A primeira versão devolvia `agora` para todos, e o passo de quinze
     * segundos entrava com a hora de quinze segundos ATRÁS — quem dormiu foi a
     * função, mas o carimbo era o do começo. Medido em 2026/08/18: o teste viu
     * diferença de zero segundos entre dois passos que saíram com quinze de
     * intervalo.
     *
     * A hora de uma mensagem é quando ela sai. Deixar o banco decidir é a
     * única forma de isso continuar verdade depois de uma espera.
     */
    const quando = atraso ? new Date(agora.getTime() + atraso * 1000) : null;
    const dormir = pausa < ESPERA_NO_ENVIO ? pausa : 0;

    if (passo.kind === "text") {
      const frase = catalogo.frases.find((f) => f.name === passo.name);

      // Passo que aponta para algo apagado é PULADO, e não derruba o resto:
      // quem apagou uma frase não quis que a sequência inteira parasse de
      // funcionar sem aviso.
      if (!frase) continue;

      saida.push({
        content: {
          version: "1",
          type: "text",
          kind: "text",
          text: frase.text,
        },
        quando,
        dormir,
      });

      continue;
    }

    const midia = catalogo.midias.find((m) => m.uri === passo.uri);

    if (!midia) continue;

    saida.push({
      content: {
        version: "1",
        type: "file",
        kind: midia.kind,
        file: {
          uri: midia.uri,
          mime_type: midia.mime_type,
          name: midia.name,
          size: midia.size,
        },
      },
      quando,
      dormir,
    });
  }

  return saida;
}
