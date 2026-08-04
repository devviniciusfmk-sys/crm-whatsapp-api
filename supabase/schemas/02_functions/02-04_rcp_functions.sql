create function public.init_data(
  p_organization_id uuid,
  p_limit integer default 200,
  p_per_conversation integer default 10,
  p_since timestamptz default null,
  p_until timestamptz default null
)
returns json
language plpgsql
stable
security invoker
set search_path to ''
as $$
declare
  _messages json;
  _conversations json;
  _conversation_ids uuid[];
begin
  -- Windowed messages: up to p_per_conversation per conversation, total p_limit
  with windowed as (
    select m.*,
      row_number() over (
        partition by m.conversation_id
        order by m.timestamp desc
      ) as rn
    from public.messages m
    where m.organization_id = p_organization_id
      and (p_since is null or m.timestamp > p_since)
      and (p_until is null or m.timestamp < p_until)
  ),
  limited as (
    select * from windowed
    where rn <= p_per_conversation
    order by timestamp desc
    limit p_limit
  )
  select
    coalesce(json_agg(row_to_json(l.*)), '[]'::json),
    array_agg(distinct l.conversation_id)
  into _messages, _conversation_ids
  from limited l;

  -- Fetch conversations for the messages returned
  select coalesce(json_agg(row_to_json(c.*)), '[]'::json)
  into _conversations
  from public.conversations c
  where c.id = any(_conversation_ids);

  return json_build_object(
    'conversations', _conversations,
    'messages', _messages
  );
end;
$$;

-- Hiding a message from the CRM is the only write the UI is allowed to make to
-- a row in public.messages, and it goes through a function rather than an
-- update policy on purpose: a policy broad enough to permit it would also let
-- a client forge `read`, `delivered` or `failed` stamps, which the dispatcher,
-- the retry cron and the billing triggers all trust. Here the merge is fixed
-- and the caller only chooses which message.
--
-- The name says CRM because that is the whole of it: nothing is sent to
-- WhatsApp. The Cloud API cannot recall a delivered message, so the customer's
-- copy stays exactly where it is — the message stops being shown to the team,
-- and that is all.
--
-- Un-hiding writes a JSON null rather than dropping the key, because the
-- `set_status` trigger merges every update through public.merge_update and a
-- removed key would simply be merged back. Same idiom the conversation extras
-- already use for `pinned`.
--
-- - 2026/07/28
create function public.set_message_hidden(
  p_message_id uuid,
  p_hidden boolean default true
)
returns void
language plpgsql
security definer
set search_path to ''
as $$
begin
  update public.messages
  set status = jsonb_build_object('hidden', case when p_hidden then now() end)
  where id = p_message_id
    and organization_id in (select public.get_authorized_orgs('member'));

  if not found then
    raise exception 'message not found or not authorized'
      using errcode = 'insufficient_privilege';
  end if;
end;
$$;

-- Blocks a contact address, or lifts the block.
--
-- Goes through a function because public.contacts_addresses deliberately does
-- not let clients touch this column. The update policy defers to
-- public.contact_address_update_rules, which requires the incoming `status` and
-- `extra` to be identical to the stored ones — in effect freezing both, so that
-- the only thing a member can change on an address is which contact it belongs
-- to. That restriction is worth keeping: `extra.synced` mirrors state owned by
-- Meta, and a client able to rewrite it would desynchronise the address book.
--
-- Blocking is the one exception the CRM needs, and it is narrow: one column,
-- two possible values, on a row the caller already has read access to. A
-- security definer function grants exactly that and nothing else, the same
-- shape public.set_message_hidden uses for the same reason.
--
-- It lives on the address rather than on the contact because an address always
-- exists — a stranger who writes for the first time has a row here and often no
-- contact record at all, and that stranger is precisely who gets blocked.
--
-- agent-client reads this before answering. Nothing is sent to WhatsApp: the
-- Cloud API gives a business no way to stop someone from writing, so the
-- messages keep arriving and keep being stored. What the block buys is silence
-- — no automated reply, and the thread out of the conversation list.
--
-- - 2026/07/31
create function public.set_contact_address_blocked(
  p_address text,
  p_service public.service,
  p_blocked boolean default true
)
returns void
language plpgsql
security definer
set search_path to ''
as $$
begin
  update public.contacts_addresses
  set status = case when p_blocked then 'blocked' else 'active' end
  where address = p_address
    and service = p_service
    and organization_id in (select public.get_authorized_orgs('member'));

  -- A missing row and an unauthorised one answer the same way on purpose:
  -- confirming that an address exists inside an organization the caller cannot
  -- read would leak what the select policy is there to hide.
  if not found then
    raise exception 'contact address not found or not authorized'
      using errcode = 'insufficient_privilege';
  end if;
end;
$$;

-- `create function` grants execute to public by default. The messages policies
-- are granted `to authenticated, anon` — anon being how an API-key caller
-- arrives — and this follows them.
revoke execute on function
  public.set_contact_address_blocked(text, public.service, boolean)
from public;

grant execute on function
  public.set_contact_address_blocked(text, public.service, boolean)
to anon, authenticated, service_role;

-- Cancels a message that was scheduled and has not gone out yet.
--
-- Deleting, not hiding. A future-dated row is not a message: nothing reached
-- WhatsApp, nobody saw it, and there is no history worth keeping — unlike
-- public.set_message_hidden, which deals with messages the customer already
-- received and whose copy cannot be recalled.
--
-- Goes through a function for the same reason everything else here does:
-- public.messages grants clients no delete at all, and the blanket rule is
-- worth keeping. What this opens is narrow and checked in one place: a row of
-- this member's organization, outgoing, still in the future, and still only
-- pending. A message already accepted, sent, delivered or failed is history
-- and stays.
--
-- The window matters. `timestamp > now()` is what makes this safe to expose:
-- the dispatcher only picks up rows whose hour has come, so anything this
-- function can delete is provably unsent. - 2026/08/02
create function public.cancel_scheduled_message(p_message_id uuid)
returns void
language plpgsql
security definer
set search_path to ''
as $$
begin
  delete from public.messages
  where id = p_message_id
    and organization_id in (select public.get_authorized_orgs('member'))
    and direction = 'outgoing'::public.direction
    and timestamp > now()
    and status ? 'pending'
    and not (status ?| array['accepted', 'sent', 'delivered', 'read', 'failed']);

  if not found then
    raise exception 'scheduled message not found, already sent, or not authorized'
      using errcode = 'insufficient_privilege';
  end if;
end;
$$;

-- Quem está precisando que a memória seja refeita.
--
-- A memória do contato é um resumo em `contacts.extra.summary`, e existe para o
-- assistente não reler a conversa inteira a cada mensagem. Uma conversa de seis
-- meses não cabe na janela de contexto, e o pedaço que cabe é sempre o errado —
-- o começo, onde a pessoa disse que é alérgica, é o primeiro a sair.
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
