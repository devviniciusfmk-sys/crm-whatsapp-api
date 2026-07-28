-- Mint an API key for an organization.
--
-- api_keys stores only sha256(key), so a key can no longer be created with a
-- plain INSERT — the caller would have to know the plaintext to hash it, and
-- nothing would guarantee its entropy. This function is the single entry point:
-- it generates the secret, persists the hash, and returns the plaintext exactly
-- once. There is no way to read it back afterwards.
--
-- security definer because the INSERT policy on api_keys was removed; the
-- authorization check below is the actual boundary.
create function public.create_api_key(
  p_organization_id uuid,
  p_name text,
  p_role public.role default 'member'
) returns table (api_key_id uuid, api_key text)
language plpgsql
security definer
set search_path to ''
as $$
declare
  _key text;
  _id uuid;
begin
  if p_organization_id is null or coalesce(trim(p_name), '') = '' then
    raise exception using
      errcode = '22023',
      message = 'organization_id and name are required';
  end if;

  -- Only an owner of the target org may mint keys. get_authorized_orgs returns
  -- the empty set (it deliberately does not raise) when the caller lacks the
  -- role, so the check has to be explicit here.
  if not exists (
    select 1 from public.get_authorized_orgs('owner') as authorized(org_id)
    where authorized.org_id = p_organization_id
  ) then
    raise exception using
      errcode = '42501',
      message = 'insufficient permissions, owner role required';
  end if;

  -- 244 bits from pg_strong_random (gen_random_uuid is a v4 UUID). Built-in, so
  -- this does not pull in pgcrypto's gen_random_bytes.
  _key := 'obsp_' ||
    replace(gen_random_uuid()::text, '-', '') ||
    replace(gen_random_uuid()::text, '-', '');

  insert into public.api_keys (organization_id, name, role, key_hash)
  values (p_organization_id, trim(p_name), p_role, public.hash_api_key(_key))
  returning id into _id;

  -- The only moment the plaintext key leaves the database.
  return query select _id, _key;
end;
$$;

-- `create function` grants execute to `public` by default, and Supabase's
-- default privileges add anon/authenticated/service_role on top; spell the ACL
-- out so it does not depend on either (same treatment as the vault accessors in
-- 02-05_vault_secrets.sql). The owner check above is the real boundary.
-- service_role is revoked because it cannot use this function anyway: it sends
-- neither a JWT nor an `api-key` header, so get_authorized_orgs raises.
revoke execute on function
  public.create_api_key(uuid, text, public.role)
from public, service_role;

grant execute on function public.create_api_key(uuid, text, public.role)
to anon, authenticated;
