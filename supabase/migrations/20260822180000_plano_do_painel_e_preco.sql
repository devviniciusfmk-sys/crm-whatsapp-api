-- O plano daqui aponta para o plano DE LÁ, e carrega o preço de venda.
--
-- `painel_pacote_id` é o hashid do pacote na Sigma — o mesmo que vai em
-- `packageId` ao criar e ao renovar cliente. Sem ele não há como vender: a API
-- não aceita nome de plano, só o hashid.
--
-- E ele é de UM TIPO SÓ. Os hashids do painel colidem entre tipos: no piloto,
-- `ANKWPKDPRq` é ao mesmo tempo um pacote e o revendedor "rodnei", e
-- `BV4D3rLaqZ` é um servidor e o revendedor "super-sharkstreaming". Guardar
-- "o hashid" numa coluna genérica seria convidar a usar o de pacote onde se
-- espera o de revendedor — e isso não dá erro, acerta a conta de outra pessoa.
-- Por isso o nome diz o tipo.
--
-- `preco` é em centavos, como `cobrancas.valor` e tudo mais que é dinheiro
-- neste banco. Real em `numeric` é o caminho conhecido para 19,90 virar
-- 19,899999. - 2026/08/22
alter table public.iptv_pacotes
add column if not exists painel_pacote_id text,
add column if not exists preco integer;

comment on column public.iptv_pacotes.painel_pacote_id is
  'Hashid do PACOTE na Sigma. Vai em packageId ao criar e renovar cliente.';

comment on column public.iptv_pacotes.preco is
  'Preço de venda em centavos. 1990 = R$ 19,90.';
