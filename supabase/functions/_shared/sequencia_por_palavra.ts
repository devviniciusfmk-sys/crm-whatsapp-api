import type { OrganizationExtra } from "./types/extra_types.ts";

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
 * `agent-client`, com as duas travas que a tela promete: uma vez por conversa,
 * e só quando o assistente não vai responder. Um gatilho que dispara enquanto
 * o assistente também responde manda a loja falar duas vezes ao mesmo tempo.
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
 * As mensagens de uma sequência, já com a hora de cada uma.
 *
 * A pausa de cada passo conta a partir do anterior, então a hora do passo três
 * é a soma das pausas até ele. Passo sem pausa sai agora.
 *
 * Devolve o conteúdo e o carimbo; quem insere é quem chamou, que é onde estão
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
      kind: string;
    }[];
  },
  agora = new Date(),
) {
  const saida: { content: Record<string, unknown>; quando: Date }[] = [];

  let atraso = 0;

  for (const passo of sequencia.steps ?? []) {
    atraso += passo.esperar ?? 0;

    const quando = new Date(agora.getTime() + atraso * 1000);

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
    });
  }

  return saida;
}
