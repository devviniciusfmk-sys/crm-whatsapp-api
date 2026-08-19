-- Até quando vale o que foi pago.
--
-- Um corte de cabelo não vence; um plano, sim. Quem vende assinatura precisa
-- dizer ao cliente "válido até tal dia" na confirmação, e sem isso a mensagem
-- de pagamento fica devendo a única informação que ele vai procurar depois.
--
-- Copiado do catálogo para a cobrança, e não lido de lá na hora de exibir: a
-- validade do plano pode mudar amanhã, e a assinatura vendida ontem continua
-- valendo o que valia. É a mesma razão de os itens serem cópia.
alter table public.cobrancas
add column if not exists validade_dias integer;

-- Calculado no pagamento, não no envio: o plano começa a valer quando o
-- dinheiro entra, e não quando a cobrança foi mandada. Entre uma coisa e outra
-- pode passar uma semana.
alter table public.cobrancas
add column if not exists vence_em timestamp with time zone;

comment on column public.cobrancas.validade_dias is
  'Por quantos dias vale o que foi pago. Nulo em serviço que não vence.';

comment on column public.cobrancas.vence_em is
  'Preenchido quando a cobrança é paga: a data do pagamento mais a validade.';
