alter table public.waitlist enable row level security;

-- Permissão explícita, pelo mesmo motivo que em `time_off` e `professionals`:
-- os privilégios padrão do projeto cobrem a produção e não cobrem um banco
-- local montado do zero pelas migrações.
grant select, insert, update, delete on public.waitlist
to anon, authenticated, service_role;

create policy "members can read their orgs waitlist"
on public.waitlist
for select
to authenticated, anon
using (
  organization_id in (
    select public.get_authorized_orgs('member')
  )
);

-- Membro, como bloquear horário e como marcar: tirar alguém da fila de espera é
-- ato de atendimento. Quem está no balcão quando o cliente liga dizendo que não
-- quer mais precisa poder riscar na hora.
create policy "members can manage their orgs waitlist"
on public.waitlist
for all
to authenticated, anon
using (
  organization_id in (
    select public.get_authorized_orgs('member')
  )
);
