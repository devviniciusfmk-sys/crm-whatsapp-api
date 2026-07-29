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
