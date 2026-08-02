alter table public.appointments enable row level security;

create policy "members can read their orgs appointments"
on public.appointments
for select
to authenticated, anon
using (
  organization_id in (
    select public.get_authorized_orgs('member')
  )
);

-- Membro, e não admin: quem atende é quem marca. Uma agenda que só o dono pode
-- mexer não é agenda de atendimento, é relatório.
create policy "members can manage their orgs appointments"
on public.appointments
for all
to authenticated, anon
using (
  organization_id in (
    select public.get_authorized_orgs('member')
  )
);
