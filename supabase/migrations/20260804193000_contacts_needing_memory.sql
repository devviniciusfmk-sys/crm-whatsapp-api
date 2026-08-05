-- A fila da memória do contato: quem precisa que o resumo seja refeito.
--
-- A função em si veio do schema declarativo
-- (`supabase/schemas/02_functions/02-04_rcp_functions.sql`); o comentário longo
-- que explica as três condições está lá.
--
-- Escrita à mão a partir do `db diff`, como as anteriores: o diff continua
-- propondo 180 `revoke` sobre todas as tabelas e a reescrita de funções que só
-- diferem por CRLF, e nada disso tem a ver com esta mudança.
--
-- Só cria a fila. Quem a consome é a função de borda `contact-memory`, e quem a
-- chama de tempos em tempos é um cron que mora em outra migração — de
-- propósito, porque ligar o cron é decidir gastar crédito de modelo sozinho, e
-- essa decisão é de quem opera. - 2026/08/04

set check_function_bodies = off;

create or replace function public.contacts_needing_memory(p_limit integer default 20)
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
as $function$
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
$function$;
