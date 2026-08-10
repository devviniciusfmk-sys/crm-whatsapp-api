-- Onde avisar quem cuida da loja quando ele não está olhando a tela.
--
-- Podada à mão a partir de `supabase db diff`, como as anteriores: a ferramenta
-- emite 168 `revoke` sobre tabelas que não têm nada com isto, e mais a
-- redefinição de dez funções intocadas. Aqui fica só a tabela nova.

create table public.push_subscriptions (
  id uuid default gen_random_uuid() not null,
  organization_id uuid not null,
  user_id uuid not null,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  user_agent text,
  extra jsonb default '{}'::jsonb not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

alter table only public.push_subscriptions
add constraint push_subscriptions_pkey
primary key (id);

alter table only public.push_subscriptions
add constraint push_subscriptions_endpoint_key
unique (endpoint);

alter table only public.push_subscriptions
add constraint push_subscriptions_organization_id_fkey
foreign key (organization_id)
references public.organizations(id)
on delete cascade;

alter table only public.push_subscriptions
add constraint push_subscriptions_user_id_fkey
foreign key (user_id)
references auth.users(id)
on delete cascade;

create index push_subscriptions_organization_idx
on public.push_subscriptions
using btree (organization_id);

create trigger set_updated_at
before update
on public.push_subscriptions
for each row
execute function public.moddatetime('updated_at');

create trigger set_extra
before update
on public.push_subscriptions
for each row
execute function public.merge_update('extra');

alter table public.push_subscriptions enable row level security;

grant select, insert, update, delete on public.push_subscriptions
to anon, authenticated, service_role;

create policy "people manage their own push subscriptions"
on public.push_subscriptions
for all
to authenticated, anon
using (
  user_id = (select auth.uid())
  and organization_id in (
    select public.get_authorized_orgs('member')
  )
)
with check (
  user_id = (select auth.uid())
  and organization_id in (
    select public.get_authorized_orgs('member')
  )
);
