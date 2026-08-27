-- Escrita à mão, mesmo motivo das migrações anteriores desta leva: o
-- `supabase db diff` deste projeto vem misturado com uma drift grande e
-- não relacionada entre os arquivos de schema e o histórico de migrações
-- já aplicado. Este arquivo contém só os objetos novos de
-- responsavel_id/reuniao_em/comissoes — nenhum drop.

alter table "public"."negocios"
  add column "responsavel_id" uuid references auth.users(id),
  add column "reuniao_em" timestamptz;

create table "public"."comissoes" (
  "id" uuid primary key default gen_random_uuid(),
  "organization_id" uuid not null references public.organizations(id) on delete cascade,
  "negocio_id" uuid not null references public.negocios(id) on delete cascade,
  "agent_id" uuid not null references auth.users(id),
  "tipo" text not null default 'reuniao_marcada'
    check (tipo in ('reuniao_marcada')),
  "valor" numeric not null,
  "status" text not null default 'ativa'
    check (status in ('ativa', 'estornada')),
  "criado_em" timestamptz not null default now(),
  "estornado_em" timestamptz
);

create index comissoes_organization_id_idx on public.comissoes (organization_id);

create index comissoes_agent_id_idx on public.comissoes (organization_id, agent_id);

create unique index comissoes_negocio_tipo_ativa_idx
  on public.comissoes (negocio_id, tipo) where status = 'ativa';

alter table "public"."comissoes" enable row level security;

create policy "members can see their orgs comissoes"
on public.comissoes
for select
to authenticated
using (
  organization_id in (
    select public.get_authorized_orgs('member')
  )
);

create or replace function public.marcar_reuniao_negocio(
  _negocio uuid,
  _quando timestamptz
) returns public.negocios
language plpgsql
security definer
set search_path = ''
as $$
declare
  _negocio_row public.negocios%rowtype;
  _valor numeric;
begin
  update public.negocios
  set reuniao_em = _quando,
      responsavel_id = coalesce(responsavel_id, auth.uid())
  where id = _negocio
    and organization_id in (select public.get_authorized_orgs('member'))
  returning * into _negocio_row;

  if not found then
    raise exception 'negócio não encontrado ou sem permissão';
  end if;

  if exists (
    select 1 from public.comissoes
    where negocio_id = _negocio and tipo = 'reuniao_marcada' and status = 'ativa'
  ) then
    return _negocio_row;
  end if;

  select coalesce((o.extra->>'sdr_comissao_por_reuniao')::numeric, 30)
  into _valor
  from public.organizations o
  where o.id = _negocio_row.organization_id;

  insert into public.comissoes (organization_id, negocio_id, agent_id, tipo, valor)
  values (_negocio_row.organization_id, _negocio, _negocio_row.responsavel_id, 'reuniao_marcada', _valor);

  return _negocio_row;
end;
$$;

revoke execute on function public.marcar_reuniao_negocio(uuid, timestamptz)
from public, anon;

grant execute on function public.marcar_reuniao_negocio(uuid, timestamptz)
to authenticated;

create or replace function public.desmarcar_reuniao_negocio(_negocio uuid)
returns public.negocios
language plpgsql
security definer
set search_path = ''
as $$
declare
  _negocio_row public.negocios%rowtype;
begin
  update public.negocios
  set reuniao_em = null
  where id = _negocio
    and organization_id in (select public.get_authorized_orgs('member'))
  returning * into _negocio_row;

  if not found then
    raise exception 'negócio não encontrado ou sem permissão';
  end if;

  update public.comissoes
  set status = 'estornada', estornado_em = now()
  where negocio_id = _negocio and tipo = 'reuniao_marcada' and status = 'ativa';

  return _negocio_row;
end;
$$;

revoke execute on function public.desmarcar_reuniao_negocio(uuid)
from public, anon;

grant execute on function public.desmarcar_reuniao_negocio(uuid)
to authenticated;
