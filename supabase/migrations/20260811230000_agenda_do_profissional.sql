-- Quem é profissional vê a agenda DELE. Quem não é vê a da casa.
--
-- O barbeiro passou a entrar no sistema ontem, e a agenda abria filtrada nele —
-- filtrada, não isolada. Bastava clicar em "Todos" para ver a agenda dos
-- colegas, com nome de cliente e valor de cada atendimento.
--
-- A condição mora na política da própria tabela, e não num quarto papel: um
-- papel novo mexeria em `get_authorized_orgs`, que decide a permissão de TODAS
-- as tabelas. Aqui o pior caso é a agenda.
--
-- Escrita à mão: `db diff` emitiria os 168 `revoke` de sempre junto.

create or replace function public.professional_of_caller(_organization_id uuid)
returns uuid
language sql
stable
security definer
set search_path to ''
as $$
  select p.id
  from public.professionals as p
  join public.agents as a
    on a.id::text = p.extra ->> 'agent_id'
  where p.organization_id = _organization_id
    and a.user_id = (select auth.uid())
  limit 1;
$$;

grant execute on function public.professional_of_caller(uuid)
to anon, authenticated, service_role;

drop policy if exists "members can read their orgs appointments"
on public.appointments;

drop policy if exists "members can manage their orgs appointments"
on public.appointments;

create policy "members see their orgs appointments"
on public.appointments
for select
to authenticated, anon
using (
  organization_id in (
    select public.get_authorized_orgs('member')
  )
  and (
    public.professional_of_caller(organization_id) is null
    or professional_id = public.professional_of_caller(organization_id)
  )
);

create policy "members manage their orgs appointments"
on public.appointments
for all
to authenticated, anon
using (
  organization_id in (
    select public.get_authorized_orgs('member')
  )
  and (
    public.professional_of_caller(organization_id) is null
    or professional_id = public.professional_of_caller(organization_id)
  )
)
with check (
  organization_id in (
    select public.get_authorized_orgs('member')
  )
  and (
    public.professional_of_caller(organization_id) is null
    or professional_id = public.professional_of_caller(organization_id)
  )
);
