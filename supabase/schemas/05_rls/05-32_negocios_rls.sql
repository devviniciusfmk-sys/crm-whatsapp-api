alter table public.negocios enable row level security;

create policy "members can manage their orgs negocios"
on public.negocios
for all
to authenticated, anon
using (
  organization_id in (
    select public.get_authorized_orgs('member')
  )
);
