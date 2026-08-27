alter table public.comissoes enable row level security;

-- Só leitura direta: quem escreve são as funções de 04-33, que já
-- conferem `get_authorized_orgs` por dentro (`security definer`).
create policy "members can see their orgs comissoes"
on public.comissoes
for select
to authenticated
using (
  organization_id in (
    select public.get_authorized_orgs('member')
  )
);
