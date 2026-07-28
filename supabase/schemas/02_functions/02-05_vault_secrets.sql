-- Meta (WhatsApp) access tokens live in Supabase Vault, never in
-- `organizations_addresses.extra`. The jsonb column is readable by every member
-- of the org through the "members can read their orgs addresses" RLS policy —
-- and it is also shipped verbatim to customer webhooks by `notify_webhook`
-- (`to_jsonb(new)`), so a token stored there is effectively public to the org.
--
-- Secrets are keyed by a deterministic name derived from the address' primary
-- key, so no extra lookup table is needed:
--
--   wa_token:<organization_id>:<address>
--
-- Only `service_role` may call the accessors; `authenticated`/`anon` are
-- revoked explicitly because `create function` grants execute to `public` by
-- default.

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

-- Without this the secret outlives the row: `organizations_addresses` is
-- deleted by cascade when an organization is removed, and Instagram-style data
-- deletion requests delete the row directly.
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

-- Postgres already refuses a direct call ("trigger functions can only be called
-- as triggers"), but keep the ACL consistent with the accessors above.
revoke execute on function public.drop_whatsapp_access_token_on_delete()
from public, anon, authenticated;
