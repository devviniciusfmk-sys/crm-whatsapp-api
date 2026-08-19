/**
 * A mensagem que sai quando o pagamento entra.
 *
 * ESPELHO de `open-bsp-ui/src/utils/confirmacaoDePagamento.ts`, e tem de
 * continuar dizendo a mesma coisa: a tela manda esta mensagem quando alguém
 * toca em "Recebi", e este arquivo manda quando o gateway avisa. Duas versões
 * que divergem viram dois clientes recebendo confirmações diferentes pela
 * mesma compra.
 *
 * A diferença de forma é uma só e é proposital: aqui o vencimento chega
 * PRONTO, calculado por `public.vencimento_da_cobranca` no banco, porque
 * quitar e avisar acontecem no mesmo instante. Do lado da tela ele é calculado
 * antes de enviar, para a mensagem e o registro dizerem a mesma data.
 *
 * ## Por que ela existe
 *
 * Quem paga por Pix fica sem saber se chegou. O extrato do banco dele diz que
 * saiu; nada diz que a loja viu. Esse vão de silêncio é onde nasce o "oi, você
 * recebeu?" — que custa uma pessoa parando o que faz, várias vezes por dia.
 *
 * ## Por que repete o que já foi dito
 *
 * O valor e os itens aparecem de novo, mesmo estando na cobrança logo acima:
 * esta é a mensagem que FICA, e é ela que a pessoa procura três semanas depois
 * para saber se pagou o corte de agosto. - 2026/08/19
 */

const emReais = (valor: number) => `R$ ${valor.toFixed(2).replace(".", ",")}`;

const dia = (quando: Date) => {
  const dois = (n: number) => String(n).padStart(2, "0");

  return `${dois(quando.getDate())}/${dois(quando.getMonth() + 1)}/${quando.getFullYear()}`;
};

export function confirmacaoDePagamento(
  cobranca: {
    itens?: { nome: string; valor: number }[] | null;
    valor: number;
    vence_em?: string | null;
  },
  loja?: string,
  cliente?: string,
  quando: Date = new Date(),
): string {
  const itens = cobranca.itens ?? [];

  /* Os itens só quando são mais de um. Com um só, o nome já está na linha do
   * valor e repeti-lo seria a mesma informação duas vezes numa mensagem de
   * cinco linhas. */
  const linhaDosItens = itens.length > 1
    ? itens.map((i) => `▫️ ${i.nome} · ${emReais(i.valor)}`).join("\n")
    : itens[0]?.nome
    ? `🧾 ${itens[0].nome}`
    : null;

  return [
    "✅ *Pagamento confirmado!*",
    "",
    cliente ? `👤 *Cliente:* ${cliente}` : null,
    linhaDosItens,
    `💰 *Valor:* ${emReais(Number(cobranca.valor))}`,
    `📅 *Data:* ${dia(quando)}`,
    cobranca.vence_em
      ? `🗓 *Válido até:* ${dia(new Date(cobranca.vence_em))}`
      : null,
    "",
    "Obrigado pela preferência! 🙏",
    loja ? `_${loja}_` : null,
  ].filter((linha) => linha !== null).join("\n");
}
