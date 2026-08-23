/**
 * # O preço do plano vira REAIS, como todo o resto do dinheiro daqui
 *
 * Escrevi `preco integer` e comentei "em centavos, 1990 = R$ 19,90". Estava
 * errado e era eu contra o banco inteiro:
 *
 *   cobrancas.valor          numeric   `[{"nome":"Corte","valor":45}]`
 *   appointments.price       numeric   "como o resto do dinheiro deste banco"
 *   billing.payments.amount  numeric
 *
 * `formatMoney`, que desenha dinheiro em toda tela do produto, não divide por
 * nada — ele recebe reais. E `numeric` existe justamente para guardar 19,90
 * sem virar 19,899999.
 *
 * ## Como isso apareceu
 *
 * Na simulação de um mês de loja, em 2026/08/23: o preço saiu do plano em
 * "centavos" e entrou em `cobrancas.valor`, que é reais. O caixa somou e
 * mostrou **R$ 19.950** de comissão onde eram R$ 199,50. Cem vezes, na tela
 * que diz quanto pagar a cada funcionário.
 *
 * Ninguém tinha vendido nada ainda, então nenhuma conta de verdade saiu errada
 * — mas a primeira sairia.
 *
 * A conversão divide por 100 porque foi assim que os três planos do piloto
 * foram cadastrados: 1990, 4990, 11990 e 1500 viram 19,90, 49,90, 119,90 e
 * 15,00. - 2026/08/23
 */
alter table public.iptv_pacotes
alter column preco type numeric using (preco::numeric / 100),
alter column preco_tela_extra type numeric using (preco_tela_extra::numeric / 100);

comment on column public.iptv_pacotes.preco is
  'Preço de venda em REAIS, como todo dinheiro deste banco. 19.90 = R$ 19,90.';

comment on column public.iptv_pacotes.preco_tela_extra is
  'Reais por tela ALÉM das que o plano já inclui. Nulo = não vende extra.';
