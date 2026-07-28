alter table public.api_keys enable row level security;

-- Note: Self-read check is merged here (not a separate policy) because
-- get_authorized_orgs raises an exception on insufficient permissions.
-- Separate policies would fail: even if self-read passes, the owner policy's
-- exception aborts the query. Using OR short-circuits: if key matches,
-- get_authorized_orgs is never called.
create policy "owners can read their orgs api keys"
on public.api_keys
for select
to authenticated, anon
using (
  key_hash = public.hash_api_key(
    current_setting('request.headers', true)::json->>'api-key'
  )
  or organization_id in (
    select public.get_authorized_orgs('owner')
  )
);

-- No INSERT policy on purpose: keys are minted by public.create_api_key(), the
-- only place that generates the secret and stores its hash. A direct INSERT
-- would let the client choose (or reuse) the hashed value.

create policy "owners can delete their orgs api keys"
on public.api_keys
for delete
to authenticated, anon
using (
  organization_id in (
    select public.get_authorized_orgs('owner')
  )
);