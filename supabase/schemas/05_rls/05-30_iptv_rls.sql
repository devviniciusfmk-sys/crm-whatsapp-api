-- Quem atende é quem gera teste, então a regra é `member` e não `admin` — a
-- mesma leitura de `cobrancas`. Um teste que só o dono consegue gerar não serve
-- ao balcão às nove da noite, que é quando o cliente pede.
--
-- A configuração (servidor, pacote, app) fica em `admin`: são as credenciais do
-- painel e os preços, e trocar isso no meio de um atendimento é o tipo de
-- estrago que ninguém desfaz sozinho.

alter table public.iptv_servidores enable row level security;

drop policy if exists "members see their orgs iptv servidores"
on public.iptv_servidores;

create policy "members see their orgs iptv servidores"
on public.iptv_servidores
for select
to authenticated, anon
using (
  organization_id in (select public.get_authorized_orgs('member'))
);

drop policy if exists "admins manage their orgs iptv servidores"
on public.iptv_servidores;

create policy "admins manage their orgs iptv servidores"
on public.iptv_servidores
for all
to authenticated, anon
using (
  organization_id in (select public.get_authorized_orgs('admin'))
)
with check (
  organization_id in (select public.get_authorized_orgs('admin'))
);

alter table public.iptv_pacotes enable row level security;

drop policy if exists "members see their orgs iptv pacotes" on public.iptv_pacotes;

-- Quem enxerga o servidor enxerga os pacotes dele. A regra de quem pertence a
-- qual organização já está resolvida uma vez, acima; repeti-la aqui seria a
-- segunda definição da mesma coisa.
create policy "members see their orgs iptv pacotes"
on public.iptv_pacotes
for select
to authenticated, anon
using (
  exists (
    select 1 from public.iptv_servidores s
    where s.id = iptv_pacotes.servidor_id
  )
);

drop policy if exists "admins manage their orgs iptv pacotes"
on public.iptv_pacotes;

create policy "admins manage their orgs iptv pacotes"
on public.iptv_pacotes
for all
to authenticated, anon
using (
  exists (
    select 1 from public.iptv_servidores s
    where s.id = iptv_pacotes.servidor_id
      and s.organization_id in (select public.get_authorized_orgs('admin'))
  )
)
with check (
  exists (
    select 1 from public.iptv_servidores s
    where s.id = iptv_pacotes.servidor_id
      and s.organization_id in (select public.get_authorized_orgs('admin'))
  )
);

alter table public.iptv_apps enable row level security;

drop policy if exists "members see their orgs iptv apps" on public.iptv_apps;

create policy "members see their orgs iptv apps"
on public.iptv_apps
for select
to authenticated, anon
using (
  exists (
    select 1 from public.iptv_pacotes p
    where p.id = iptv_apps.pacote_id
  )
);

drop policy if exists "admins manage their orgs iptv apps" on public.iptv_apps;

create policy "admins manage their orgs iptv apps"
on public.iptv_apps
for all
to authenticated, anon
using (
  exists (
    select 1 from public.iptv_pacotes p
    join public.iptv_servidores s on s.id = p.servidor_id
    where p.id = iptv_apps.pacote_id
      and s.organization_id in (select public.get_authorized_orgs('admin'))
  )
)
with check (
  exists (
    select 1 from public.iptv_pacotes p
    join public.iptv_servidores s on s.id = p.servidor_id
    where p.id = iptv_apps.pacote_id
      and s.organization_id in (select public.get_authorized_orgs('admin'))
  )
);

alter table public.iptv_testes enable row level security;

drop policy if exists "members see their orgs iptv testes" on public.iptv_testes;

create policy "members see their orgs iptv testes"
on public.iptv_testes
for select
to authenticated, anon
using (
  organization_id in (select public.get_authorized_orgs('member'))
);

drop policy if exists "members manage their orgs iptv testes"
on public.iptv_testes;

create policy "members manage their orgs iptv testes"
on public.iptv_testes
for all
to authenticated, anon
using (
  organization_id in (select public.get_authorized_orgs('member'))
)
with check (
  organization_id in (select public.get_authorized_orgs('member'))
);
