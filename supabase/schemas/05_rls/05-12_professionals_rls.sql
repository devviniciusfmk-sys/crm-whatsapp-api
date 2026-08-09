alter table public.professionals enable row level security;

create policy "members can read their orgs professionals"
on public.professionals
for select
to authenticated, anon
using (
  organization_id in (
    select public.get_authorized_orgs('member')
  )
);

-- Admin para escrever, e não membro como nos compromissos: marcar horário é o
-- trabalho de quem atende, mas cadastrar e desligar profissional é decisão de
-- quem manda na loja. Desativar alguém tira essa pessoa de toda a agenda futura.
create policy "admins can manage their orgs professionals"
on public.professionals
for all
to authenticated, anon
using (
  organization_id in (
    select public.get_authorized_orgs('admin')
  )
);
