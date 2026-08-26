-- A loja de números: estoque, pedidos, funções e RLS.
--
-- Migração escrita à mão porque `supabase db diff` não consegue gerar o diff
-- de `supabase/schemas/` neste repositório hoje — falha num problema
-- pré-existente e sem relação com a loja (`02-05_origem_da_conversa.sql`
-- cria um gatilho em `public.messages` antes daquela tabela existir na
-- ordem de leitura de pastas do diff). Até esse problema ser resolvido,
-- qualquer schema novo precisa de uma migração escrita à mão, como esta —
-- mesmo caso já registrado em `20260826120000_cron_da_loja.sql`.
--
-- O conteúdo abaixo é exatamente o que está em
-- `supabase/schemas/03_models/03-31_loja_numeros.sql`,
-- `supabase/schemas/03_models/03-32_loja_pedidos.sql`,
-- o acréscimo de `loja_numero_token` em
-- `supabase/schemas/02_functions/02-05_vault_secrets.sql`,
-- `supabase/schemas/04_functions_post_tables/04-31_loja.sql` e
-- `supabase/schemas/05_rls/05-31_loja_rls.sql` — copiado, não reescrito, para
-- que os dois nunca divirjam sem alguém perceber. Se algum dia `db diff`
-- voltar a funcionar neste repositório, o próximo diff vai vir vazio para
-- estes objetos, que é o sinal de que bateram certo.

-- ============================================================
-- 03-31_loja_numeros.sql
-- ============================================================

create table public.loja_numeros (
  id uuid primary key default gen_random_uuid(),
  phone_number_id text not null unique,
  waba_id text not null,
  business_id text,
  phone_number text,
  verified_name text,
  preco numeric not null default 49.90,
  status text not null default 'disponivel'
    check (status in ('disponivel','reservado','vendido','conectado','desativado')),
  organization_id uuid references public.organizations(id) on delete set null,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

create trigger set_updated_at before update on public.loja_numeros
  for each row execute function public.moddatetime('atualizado_em');

-- ============================================================
-- 03-32_loja_pedidos.sql
-- ============================================================

create table public.loja_pedidos (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  numero_id uuid not null references public.loja_numeros(id),
  comprador_user_id uuid,
  valor numeric not null,
  status text not null default 'aberto'
    check (status in ('aberto','pago','conectado','cancelado')),
  metodo text,
  codigo_pix text,
  external_id text,
  conectado_por uuid,
  criado_em timestamptz not null default now(),
  pago_em timestamptz,
  conectado_em timestamptz
);

create unique index loja_pedidos_external_id_idx
  on public.loja_pedidos (metodo, external_id) where external_id is not null;

create unique index loja_pedidos_numero_ativo_idx
  on public.loja_pedidos (numero_id) where status in ('aberto', 'pago');

create index loja_pedidos_organization_id_idx
  on public.loja_pedidos (organization_id);

-- ============================================================
-- 02-05_vault_secrets.sql (acréscimo: loja_numero_token)
-- ============================================================

create function public.loja_numero_token_secret_name(p_numero_id uuid)
returns text
language sql
immutable
set search_path to ''
as $$
  select 'loja_numero_token:' || p_numero_id::text;
$$;

revoke execute on function public.loja_numero_token_secret_name(uuid)
from public, anon, authenticated;

create function public.get_loja_numero_token(p_numero_id uuid)
returns text
language sql
stable
security definer
set search_path to ''
as $$
  select s.decrypted_secret
  from vault.decrypted_secrets s
  where s.name = public.loja_numero_token_secret_name(p_numero_id);
$$;

revoke execute on function public.get_loja_numero_token(uuid)
from public, anon, authenticated;

grant execute on function public.get_loja_numero_token(uuid) to service_role;

create function public.set_loja_numero_token(
  p_numero_id uuid,
  p_token text
)
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
  _name text := public.loja_numero_token_secret_name(p_numero_id);
  _id uuid;
begin
  if nullif(p_token, '') is null then
    raise exception 'set_loja_numero_token: token must not be null or empty';
  end if;

  select id into _id from vault.secrets where name = _name;

  if _id is null then
    perform vault.create_secret(
      p_token,
      _name,
      'System user access token for loja number ' || p_numero_id::text
    );
  else
    perform vault.update_secret(_id, p_token);
  end if;
end;
$$;

revoke execute on function public.set_loja_numero_token(uuid, text)
from public, anon, authenticated;

grant execute on function public.set_loja_numero_token(uuid, text)
to service_role;

create function public.apagar_token_do_numero_loja()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
begin
  delete from vault.secrets
  where name = public.loja_numero_token_secret_name(old.id);

  return old;
end;
$$;

drop trigger if exists apagar_token_numero_loja on public.loja_numeros;

create trigger apagar_token_numero_loja
after delete on public.loja_numeros
for each row execute function public.apagar_token_do_numero_loja();

-- ============================================================
-- 04-31_loja.sql
-- ============================================================

create or replace function public.reservar_numero_loja(
  _numero uuid,
  _organization_id uuid,
  _user_id uuid default null
) returns public.loja_pedidos
language plpgsql
security definer
set search_path to ''
as $$
declare
  _preco numeric;
  _pedido public.loja_pedidos%rowtype;
begin
  update public.loja_numeros
  set status = 'reservado',
      atualizado_em = now()
  where id = _numero
    and status = 'disponivel'
  returning preco into _preco;

  if not found then
    raise exception 'número não está mais disponível';
  end if;

  insert into public.loja_pedidos (
    organization_id, numero_id, comprador_user_id, valor, status
  ) values (
    _organization_id, _numero, _user_id, _preco, 'aberto'
  )
  returning * into _pedido;

  return _pedido;
end;
$$;

revoke execute on function public.reservar_numero_loja(uuid, uuid, uuid)
from public, anon, authenticated;

grant execute on function public.reservar_numero_loja(uuid, uuid, uuid)
to service_role;

create or replace function public.quitar_pedido_loja(
  _pedido uuid,
  _metodo text default null,
  _external_id text default null
) returns public.loja_pedidos
language plpgsql
security definer
set search_path to ''
as $$
declare
  _p public.loja_pedidos%rowtype;
begin
  select * into strict _p from public.loja_pedidos where id = _pedido;

  if _p.status in ('pago', 'conectado', 'cancelado') then
    return null;
  end if;

  update public.loja_pedidos
  set status = 'pago',
      pago_em = now(),
      metodo = coalesce(_metodo, metodo),
      external_id = coalesce(_external_id, external_id)
  where id = _pedido
  returning * into _p;

  update public.loja_numeros
  set status = 'vendido',
      organization_id = _p.organization_id,
      atualizado_em = now()
  where id = _p.numero_id;

  return _p;
end;
$$;

revoke execute on function public.quitar_pedido_loja(uuid, text, text)
from public, anon, authenticated;

grant execute on function public.quitar_pedido_loja(uuid, text, text)
to service_role;

create or replace function public.cancelar_pedido_loja(
  _pedido uuid
) returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
  _numero_id uuid;
begin
  update public.loja_pedidos
  set status = 'cancelado'
  where id = _pedido
    and status = 'aberto'
  returning numero_id into _numero_id;

  if not found then
    return;
  end if;

  update public.loja_numeros
  set status = 'disponivel',
      organization_id = null,
      atualizado_em = now()
  where id = _numero_id;
end;
$$;

revoke execute on function public.cancelar_pedido_loja(uuid)
from public, anon, authenticated;

grant execute on function public.cancelar_pedido_loja(uuid)
to service_role;

create or replace function public.expirar_reservas_loja(
  _minutos int default 30
) returns int
language plpgsql
security definer
set search_path to ''
as $$
declare
  _id uuid;
  _quantos int := 0;
begin
  for _id in
    select id
    from public.loja_pedidos
    where status = 'aberto'
      and criado_em < now() - (_minutos || ' minutes')::interval
  loop
    perform public.cancelar_pedido_loja(_id);
    _quantos := _quantos + 1;
  end loop;

  return _quantos;
end;
$$;

grant execute on function public.expirar_reservas_loja(int)
to service_role;

-- ============================================================
-- 05-31_loja_rls.sql
-- ============================================================

alter table public.loja_numeros enable row level security;

alter table public.loja_pedidos enable row level security;

create policy "owners see their orgs loja pedidos"
on public.loja_pedidos
for select
to authenticated
using (
  organization_id in (
    select public.get_authorized_orgs('owner')
  )
);
