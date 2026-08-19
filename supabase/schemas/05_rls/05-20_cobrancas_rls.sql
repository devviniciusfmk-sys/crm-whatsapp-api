alter table public.cobrancas enable row level security;

-- Membro, e não admin: quem atende é quem cobra. Uma cobrança que só o dono
-- pode registrar não serve ao balcão — é o mesmo raciocínio da agenda.
--
-- Sem o recorte por profissional que os compromissos têm: ali o barbeiro não
-- desmarca o cliente do colega, mas o caixa da loja é um só, e quem recebe
-- precisa ver o que está em aberto para não cobrar duas vezes.

create policy "members see their orgs cobrancas"
on public.cobrancas
for select
to authenticated, anon
using (
  organization_id in (
    select public.get_authorized_orgs('member')
  )
);

create policy "members manage their orgs cobrancas"
on public.cobrancas
for all
to authenticated, anon
using (
  organization_id in (
    select public.get_authorized_orgs('member')
  )
)
with check (
  organization_id in (
    select public.get_authorized_orgs('member')
  )
);
