-- As credenciais do gateway, fora de `organizations.extra`.
--
-- O ponto desta migração não é a tabela, é o privilégio de coluna no fim: a
-- chave secreta é gravável e não é legível. Ver `schemas/05_rls/05-21`.

create table if not exists public.gateway_credenciais (
  organization_id uuid primary key
    references public.organizations (id) on delete cascade,
  provedor text not null default 'amplopay',
  chave_publica text not null,
  chave_secreta text not null,
  segredo_webhook text,
  ativo boolean not null default true,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

comment on table public.gateway_credenciais is
  'Chaves do gateway de pagamento, uma linha por organização. As colunas de segredo são graváveis e não legíveis.';

comment on column public.gateway_credenciais.chave_secreta is
  'Gravável, nunca legível: o SELECT desta coluna é revogado de authenticated e anon.';

alter table public.gateway_credenciais enable row level security;

drop policy if exists "admins manage their orgs gateway credentials"
  on public.gateway_credenciais;

create policy "admins manage their orgs gateway credentials"
on public.gateway_credenciais
for all
to authenticated, anon
using (
  organization_id in (select public.get_authorized_orgs('admin'))
)
with check (
  organization_id in (select public.get_authorized_orgs('admin'))
);

-- Revogar coluna não adianta enquanto houver SELECT de tabela por cima: o
-- privilégio mais amplo vence, sem erro e sem aviso. Tira o da tabela e
-- devolve só o que pode sair.
revoke select on public.gateway_credenciais from authenticated, anon;

grant select (
  organization_id, provedor, chave_publica, ativo, criado_em, atualizado_em
) on public.gateway_credenciais to authenticated, anon;

grant insert, update on public.gateway_credenciais to authenticated, anon;
