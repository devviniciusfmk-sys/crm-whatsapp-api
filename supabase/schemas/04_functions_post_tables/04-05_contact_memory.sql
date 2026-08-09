-- Fica aqui, e não em `02_functions`, porque é `language sql`.
--
-- Postgres valida o corpo de uma função SQL na hora de criá-la, e esta lê
-- `public.messages`, `public.contacts` e `public.contacts_addresses` — tabelas
-- que só nascem em `03_models`. Em `02_functions` ela quebrava o carregamento
-- do esquema inteiro, e ninguém viu por dois dias porque o defeito não aparece
-- no banco em produção: lá a função foi criada depois das tabelas, por
-- migração. Só aparece ao montar o esquema do zero, que é o que `db diff` faz.
-- Descoberto em 2026/08/09, ao gerar a primeira migração desde então.
--
-- As vizinhas de lá são `plpgsql`, cujo corpo só é analisado na execução — por
-- isso continuam funcionando no lugar errado sem reclamar. - 2026/08/09
-- Quem está precisando que a memória seja refeita.
--
-- A memória do contato é um resumo em `contacts.extra.summary`, e existe para o
-- assistente não reler a conversa inteira a cada mensagem. Uma conversa de seis
-- meses não cabe na janela de contexto, e o pedaço que cabe é sempre o errado —
-- o começo, onde a pessoa disse que é alérgica, é o primeiro a sair.
--
--
-- Três condições, e as três importam.
--
-- **Esfriou.** Só entra conversa parada há mais de meia hora. Resumir no meio do
-- atendimento gastaria uma chamada de modelo por mensagem para reescrever quase
-- a mesma coisa, e o resumo não é usado no meio da conversa — o histórico
-- recente já está no contexto. Meia hora é o intervalo em que um atendimento
-- normal já acabou e um cliente que voltar ainda encontra a memória pronta.
--
-- **Mudou desde a última vez.** `summary_at` guarda quando o resumo foi feito;
-- se não há mensagem mais nova que ele, não há o que refazer. É isto que
-- impede o cron de reprocessar a base inteira a cada rodada.
--
-- **Tem conversa o bastante.** Duas mensagens não dão resumo, dão transcrição.
--
-- Devolve o contato e a organização; quem chama busca as mensagens e o agente.
-- `security definer` porque quem chama é o cron pela função de borda, com a
-- chave de serviço — não há usuário na sessão. - 2026/08/04
create function public.contacts_needing_memory(p_limit integer default 20)
returns table (
  contact_id uuid,
  organization_id uuid,
  conversation_id uuid,
  messages_since bigint
)
language sql
stable
security definer
set search_path to ''
as $$
  select
    c.id as contact_id,
    c.organization_id,
    (
      select m2.conversation_id
      from public.messages as m2
      join public.contacts_addresses as ca2
        on ca2.organization_id = m2.organization_id
       and ca2.service = m2.service
       and ca2.address = m2.contact_address
      where ca2.contact_id = c.id
      order by m2.timestamp desc
      limit 1
    ) as conversation_id,
    count(m.id) as messages_since
  from public.contacts as c
  join public.contacts_addresses as ca
    on ca.contact_id = c.id
  join public.messages as m
    on m.organization_id = ca.organization_id
   and m.service = ca.service
   and m.contact_address = ca.address
  where m.direction in ('incoming'::public.direction, 'outgoing'::public.direction)
    and m.timestamp > coalesce(
      (c.extra ->> 'summary_at')::timestamptz,
      timestamptz '-infinity'
    )
  group by c.id, c.organization_id
  having max(m.timestamp) < now() - interval '30 minutes'
     and count(m.id) >= 4
  order by max(m.timestamp) asc
  limit p_limit;
$$;
