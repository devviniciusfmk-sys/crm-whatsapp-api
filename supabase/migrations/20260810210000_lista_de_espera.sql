-- Quem quer um horário que não tem.
--
-- Podada à mão a partir de `supabase db diff`, como as anteriores: a ferramenta
-- emite 168 `revoke` sobre tabelas que não têm nada com isto, e mais a
-- redefinição de dez funções intocadas.

create type public.waitlist_status as enum (
  'waiting',
  'offered',
  'taken',
  'expired',
  'cancelled'
);

create table public.waitlist (
  id uuid default gen_random_uuid() not null,
  organization_id uuid not null,
  conversation_id uuid not null,
  contact_address text not null,
  service public.service not null,
  organization_address text not null,
  title text,
  desired_date date,
  desired_period text,
  professional_id uuid,
  status public.waitlist_status default 'waiting' not null,
  offered_at timestamp with time zone,
  offered_for timestamp with time zone,
  extra jsonb default '{}'::jsonb not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

alter table only public.waitlist
add constraint waitlist_pkey
primary key (id);

alter table only public.waitlist
add constraint waitlist_organization_id_fkey
foreign key (organization_id)
references public.organizations(id)
on delete cascade;

alter table only public.waitlist
add constraint waitlist_conversation_id_fkey
foreign key (conversation_id)
references public.conversations(id)
on delete cascade;

alter table only public.waitlist
add constraint waitlist_professional_id_fkey
foreign key (professional_id)
references public.professionals(id)
on delete set null;

create index waitlist_organization_status_idx
on public.waitlist
using btree (organization_id, status, created_at);

create trigger set_updated_at
before update
on public.waitlist
for each row
execute function public.moddatetime('updated_at');

create trigger set_extra
before update
on public.waitlist
for each row
execute function public.merge_update('extra');

alter table public.waitlist enable row level security;

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

create policy "members can manage their orgs waitlist"
on public.waitlist
for all
to authenticated, anon
using (
  organization_id in (
    select public.get_authorized_orgs('member')
  )
);
