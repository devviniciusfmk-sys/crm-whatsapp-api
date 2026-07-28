-- Move the Meta (WhatsApp) access token out of
-- `organizations_addresses.extra` and into Supabase Vault.
--
-- Today the token sits in plaintext inside a jsonb column that (a) every member
-- of the org can SELECT through the "members can read their orgs addresses"
-- RLS policy and (b) `notify_webhook` ships verbatim to customer webhooks via
-- `to_jsonb(new)`. See issue #9.
--
-- Locking notes (issue #12 — the deploy deadlock):
--   * `create function` / `create trigger` on `public.organizations_addresses`
--     and the backfill UPDATE only ever touch `organizations_addresses`, which
--     holds one row per connected number. `messages`, `contacts_addresses` and
--     `conversations` are not referenced at all.
--   * The two `alter table ... disable/enable trigger` statements DO take
--     ACCESS EXCLUSIVE on `organizations_addresses`. `lock_timeout` below makes
--     the migration abort quickly and loudly instead of piling up behind a
--     pg_cron transaction and deadlocking.
--   * Everything runs in the single implicit transaction Supabase wraps a
--     migration in, so a failure leaves the token where it is today.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

--------------------------------------------------------------------------------
-- 1. Vault accessors (mirrors supabase/schemas/02_functions/02-05_vault_secrets.sql)
--------------------------------------------------------------------------------

create function public.whatsapp_token_secret_name(
  p_organization_id uuid,
  p_address text
) returns text
language sql
immutable
set search_path to ''
as $$
  select 'wa_token:' || p_organization_id::text || ':' || p_address;
$$;

revoke execute on function public.whatsapp_token_secret_name(uuid, text)
from public, anon, authenticated;

create function public.get_whatsapp_access_token(
  p_organization_id uuid,
  p_address text
) returns text
language sql
stable
security definer
set search_path to ''
as $$
  select s.decrypted_secret
  from vault.decrypted_secrets s
  where s.name = public.whatsapp_token_secret_name(p_organization_id, p_address);
$$;

revoke execute on function public.get_whatsapp_access_token(uuid, text)
from public, anon, authenticated;

grant execute on function public.get_whatsapp_access_token(uuid, text)
to service_role;

create function public.set_whatsapp_access_token(
  p_organization_id uuid,
  p_address text,
  p_token text
) returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
  _name text := public.whatsapp_token_secret_name(p_organization_id, p_address);
  _id uuid;
begin
  if nullif(p_token, '') is null then
    raise exception 'set_whatsapp_access_token: token must not be null or empty';
  end if;

  -- `vault.secrets.name` is unique, so this is an upsert by name. Read from
  -- `vault.secrets` (not `decrypted_secrets`) — id/name are plaintext columns
  -- and there is no reason to decrypt just to test for existence.
  select id into _id from vault.secrets where name = _name;

  if _id is null then
    perform vault.create_secret(
      p_token,
      _name,
      'Meta access token for whatsapp address ' || p_address
    );
  else
    perform vault.update_secret(_id, p_token);
  end if;
end;
$$;

revoke execute on function
  public.set_whatsapp_access_token(uuid, text, text)
from public, anon, authenticated;

grant execute on function public.set_whatsapp_access_token(uuid, text, text)
to service_role;

create function public.delete_whatsapp_access_token(
  p_organization_id uuid,
  p_address text
) returns void
language sql
security definer
set search_path to ''
as $$
  delete from vault.secrets
  where name = public.whatsapp_token_secret_name(p_organization_id, p_address);
$$;

revoke execute on function public.delete_whatsapp_access_token(uuid, text)
from public, anon, authenticated;

grant execute on function public.delete_whatsapp_access_token(uuid, text)
to service_role;

create function public.drop_whatsapp_access_token_on_delete() returns trigger
language plpgsql
security definer
set search_path to ''
as $$
begin
  perform public.delete_whatsapp_access_token(old.organization_id, old.address);

  return old;
end;
$$;

revoke execute on function public.drop_whatsapp_access_token_on_delete()
from public, anon, authenticated;

create trigger drop_whatsapp_access_token
after delete
on public.organizations_addresses
for each row
when (old.service = 'whatsapp')
execute function public.drop_whatsapp_access_token_on_delete();

--------------------------------------------------------------------------------
-- 2. Backfill: copy every existing whatsapp token into the Vault.
--    Hand-written DML — `db diff` emits schema DDL only.
--    Instagram rows are deliberately left alone (own token lifecycle, see #9
--    follow-up).
--------------------------------------------------------------------------------

do $$
declare
  _row record;
  _count int := 0;
begin
  for _row in
    select organization_id, address, extra->>'access_token' as token
    from public.organizations_addresses
    where service = 'whatsapp'
      and nullif(extra->>'access_token', '') is not null
  loop
    perform public.set_whatsapp_access_token(
      _row.organization_id,
      _row.address,
      _row.token
    );

    _count := _count + 1;
  end loop;

  raise notice 'whatsapp tokens copied to vault: %', _count;
end;
$$;

-- Read every secret back and compare it to the value still in `extra`. If a
-- single address does not round-trip, abort before anything is stripped.
do $$
declare
  _mismatched int;
begin
  select count(*)
  into _mismatched
  from public.organizations_addresses a
  where a.service = 'whatsapp'
    and nullif(a.extra->>'access_token', '') is not null
    and public.get_whatsapp_access_token(a.organization_id, a.address)
        is distinct from a.extra->>'access_token';

  if _mismatched > 0 then
    raise exception
      'vault backfill mismatch on % whatsapp address(es); aborting before stripping extra',
      _mismatched;
  end if;
end;
$$;

--------------------------------------------------------------------------------
-- 3. Strip `access_token` from `extra`.
--
--    `set_extra` (before update, public.merge_update) merges NEW.extra into
--    OLD.extra key by key, so a key that is absent from NEW is *kept* — a plain
--    `set extra = extra - 'access_token'` would silently do nothing. The
--    trigger has to be off for this statement.
--
--    `z_notify_webhook_organizations_addresses` is disabled too: it would fire
--    one `net.http_post` per row per registered webhook, delivering an
--    address-updated event to customers for what is an internal storage change.
--------------------------------------------------------------------------------

alter table public.organizations_addresses
  disable trigger set_extra;
alter table public.organizations_addresses
  disable trigger z_notify_webhook_organizations_addresses;

update public.organizations_addresses
set extra = extra - 'access_token'
where service = 'whatsapp'
  and extra ? 'access_token';

alter table public.organizations_addresses
  enable trigger z_notify_webhook_organizations_addresses;
alter table public.organizations_addresses
  enable trigger set_extra;

-- Nothing may be left behind.
do $$
declare
  _remaining int;
begin
  select count(*)
  into _remaining
  from public.organizations_addresses
  where service = 'whatsapp'
    and extra ? 'access_token';

  if _remaining > 0 then
    raise exception
      '% whatsapp address(es) still carry extra->access_token', _remaining;
  end if;
end;
$$;
