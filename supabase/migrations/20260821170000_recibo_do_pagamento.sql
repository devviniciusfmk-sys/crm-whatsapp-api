-- Quando o cliente foi avisado de que o pagamento entrou.
--
-- A confirmação sai de três lugares e nos três é a última coisa a acontecer:
-- se o envio falhar, o pagamento continua quitado, porque o dinheiro entrou
-- e esse é o fato. O preço é que o envio perdido não deixava rastro nenhum —
-- o caixa fechava certo e o cliente era o único a saber que ficou sem
-- resposta.
--
-- Com a marca, "quem pagou e não foi avisado?" tem resposta e a tela
-- consegue reenviar.
--
-- Nulo no que já existe. O histórico não vira uma fila de reenvio: a tela
-- olha só os últimos dias, porque recibo de mês passado não é notícia para
-- ninguém.
alter table public.cobrancas
add column if not exists recibo_em timestamp with time zone;

comment on column public.cobrancas.recibo_em is
  'Quando a confirmação de pagamento foi entregue ao cliente. Nulo = não saiu.';

-- A pergunta da sincronização: pagas, recentes, sem recibo.
create index if not exists cobrancas_sem_recibo_idx
on public.cobrancas (organization_id, paga_em)
where status = 'paga' and recibo_em is null;
