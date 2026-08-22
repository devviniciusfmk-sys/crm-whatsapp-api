-- O que a loja cobra, e o que ela entrega além do que o pacote traz.
--
-- `preco_tela_extra` é por plano, e não uma regra no código: quantas telas o
-- pacote já inclui depende do plano E do servidor. O COMPLETO do piloto vem
-- com duas, o UNITV com uma, e outro servidor virá com outro número. Uma regra
-- fixa aqui erraria no primeiro servidor novo — e erraria cobrando.
--
-- `renova_sozinho` é o que separa o anual do vitalício, que no painel são o
-- MESMO pacote (1 ANO COMPLETO, 12 créditos). O cliente paga uma vez e o
-- sistema renova todo ano sem cobrar de novo. Não existe pacote vitalício em
-- lugar nenhum do catálogo: o mais longo é um ano.
--
-- Atenção a quem for ligar a renovação: ela gasta 12 créditos por ano, para
-- sempre, contra um pagamento único. É a conta que decide se o plano se paga,
-- e é do dono da loja — não do código. - 2026/08/22
alter table public.iptv_pacotes
add column if not exists preco_tela_extra integer,
add column if not exists renova_sozinho boolean not null default false;

comment on column public.iptv_pacotes.preco_tela_extra is
  'Centavos por tela ALÉM das que o pacote já inclui. Nulo = não vende extra.';

comment on column public.iptv_pacotes.renova_sozinho is
  'Renova no painel quando vencer, sem cobrar de novo. É o vitalício.';
