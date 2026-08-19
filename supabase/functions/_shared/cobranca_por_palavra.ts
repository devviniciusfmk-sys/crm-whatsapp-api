import type { OrganizationExtra } from "./types/extra_types.ts";
import { normalizar } from "./sequencia_por_palavra.ts";

/**
 * # A cobrança que dispara por palavra
 *
 * O cliente escreve "quanto é o corte?" e recebe o Pix de R$ 45 — o preço sai
 * do catálogo da loja, não de um texto escrito à parte. Mudou o preço no
 * catálogo, mudou na cobrança; não existe um segundo lugar para esquecer de
 * atualizar.
 *
 * ## Duas mensagens, sempre
 *
 * A primeira avisa o valor, a segunda leva a CHAVE sozinha. Quem paga toca
 * "copiar" na bolha e o WhatsApp copia a bolha inteira: chave com frase colada
 * em cima vira um texto que o banco não reconhece. É a mesma regra do botão da
 * tela, e por isso as duas montam as mensagens aqui.
 *
 * ## O que ela NÃO decide
 *
 * Não decide se deve cobrar. Só diz qual serviço casou e o que mandar. Quem
 * decide é `agent-client` — inclusive a precedência sobre o assistente, que
 * existe pelo mesmo motivo da sequência por palavra: casou, a resposta daquele
 * turno É a cobrança, e chamar o modelo depois seria responder duas vezes.
 *
 * - 2026/08/18
 */

type Servico = NonNullable<
  NonNullable<OrganizationExtra["appointments"]>["services"]
>[number];

/**
 * O primeiro serviço cujo gatilho aparece na mensagem, ou nada.
 *
 * O primeiro, e não o que mais casa: dois serviços com a mesma palavra é erro
 * de quem configurou, e escolher o mais longo esconderia o erro atrás de um
 * comportamento que ninguém prevê. A ordem do catálogo é onde se resolve.
 *
 * Serviço sem preço não casa nunca — cobrar zero é pior que não cobrar.
 */
export function servicoPara(
  mensagem: string,
  servicos: Servico[] | undefined,
): Servico | null {
  const texto = normalizar(mensagem);

  if (!texto) return null;

  for (const servico of servicos ?? []) {
    if (!servico?.price || Number(servico.price) <= 0) continue;

    for (const gatilho of servico.gatilhos ?? []) {
      const palavra = normalizar(gatilho);

      // Gatilho vazio casaria com tudo. A tela filtra ao gravar; esta é a
      // segunda tranca, porque o dado pode ter vindo de outro lugar.
      if (palavra && texto.includes(palavra)) return servico;
    }
  }

  return null;
}

/** Como o valor aparece para quem lê: R$ 45,00. */
export function emReais(valor: number) {
  return `R$ ${valor.toFixed(2).replace(".", ",")}`;
}

/**
 * As duas mensagens da cobrança, ou nada quando a loja não pode cobrar.
 *
 * Devolve `null` em vez de uma mensagem pela metade: sem chave cadastrada, o
 * silêncio é a resposta certa — o assistente segue e responde o preço em
 * palavras, que é o que ele já fazia. Mandar "o Pix é" sem o Pix seria pior
 * que não mandar nada.
 */
export function mensagensDaCobranca(
  servico: Servico,
  loja: { name?: string; extra?: OrganizationExtra | null },
): string[] | null {
  const chave = loja.extra?.pix?.key?.trim();

  if (!chave) return null;

  /* O asterisco é negrito no WhatsApp. O valor em destaque e a chave sozinha
   * na bolha seguinte — o mesmo que o botão da tela manda, porque duas formas
   * de cobrar com caras diferentes é o cliente perguntando qual é a certa. */
  return [
    `*${servico.name}* · ${emReais(Number(servico.price))}\n\n` +
    `Pague por Pix na chave abaixo.`,
    chave,
  ];
}
