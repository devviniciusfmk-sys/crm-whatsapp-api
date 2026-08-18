import type { OrganizationExtra } from "./types/extra_types.ts";
import { normalizar } from "./sequencia_por_palavra.ts";
import { cobrancaDaLoja } from "./pix.ts";

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
 * A primeira avisa o valor, a segunda leva o código SOZINHO. Quem paga toca
 * "copiar" na bolha e o WhatsApp copia a bolha inteira: código com frase
 * colada em cima vira um texto que o banco recusa, e a pessoa não tem como
 * saber por quê. É a mesma regra do botão da tela, e por isso as duas montam
 * as mensagens aqui.
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
  /* `name`, e não `nome`: é a forma da linha que vem do banco, e é ela que os
   * chamadores têm na mão. Traduzir aqui custou uma medição inteira — passei
   * `org` inteiro, o campo `nome` chegou vazio, o código não se montou, e a
   * cobrança simplesmente não saiu enquanto o assistente respondia no lugar
   * dela. Campo opcional não avisa quando falta. - 2026/08/18 */
  loja: { name?: string; extra?: OrganizationExtra | null },
  txid?: string,
): string[] | null {
  const valor = Number(servico.price);

  const codigo = cobrancaDaLoja(
    {
      nome: loja.name,
      chave: loja.extra?.pix?.key,
      cidade: loja.extra?.business_address?.city || loja.extra?.pix?.city,
    },
    valor,
    txid,
  );

  if (!codigo) return null;

  return [
    `${servico.name}: ${emReais(valor)}. Copie o código abaixo e cole no` +
    ` aplicativo do banco para pagar por Pix.`,
    codigo,
  ];
}
