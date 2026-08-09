-- Quem atende, quando a loja tem mais de uma cadeira.
--
-- Gerada por `supabase db diff` a partir dos arquivos de esquema e PODADA à
-- mão, como o próprio CLI avisa que às vezes é preciso ("the diff tool is not
-- foolproof"). O que saiu fora:
--
--   168 linhas de `revoke ... from anon/authenticated/service_role` em TODAS as
--   tabelas do sistema. Vinham da diferença entre as concessões que o banco de
--   produção tem e as que os arquivos de esquema declaram — aplicá-las tiraria
--   o acesso do aplicativo inteiro.
--
--   12 `create or replace function` de funções que ninguém tocou, iguais às que
--   já estão lá menos pelas quebras de linha (CRLF nos arquivos, LF no banco).
--
-- Sobrou o que esta migração é: uma tabela, uma coluna, as chaves, os índices,
-- as políticas e os dois gatilhos. - 2026/08/09

create table "public"."professionals" (
  "id" uuid not null default gen_random_uuid(),
  "organization_id" uuid not null,
  "name" text not null,
  "active" boolean not null default true,
  "extra" jsonb not null default '{}'::jsonb,
  "created_at" timestamp with time zone not null default now(),
  "updated_at" timestamp with time zone not null default now()
);

alter table "public"."professionals" enable row level security;

alter table "public"."appointments" add column "professional_id" uuid;

create unique index professionals_pkey
on public.professionals using btree (id);

create index professionals_organization_idx
on public.professionals using btree (organization_id, active);

alter table "public"."professionals"
add constraint "professionals_pkey" primary key using index "professionals_pkey";

alter table "public"."professionals"
add constraint "professionals_organization_id_fkey"
foreign key (organization_id) references public.organizations(id)
on delete cascade not valid;

alter table "public"."professionals"
validate constraint "professionals_organization_id_fkey";

-- `set null`: o compromisso de ontem sobrevive à demissão de quem o atendeu.
alter table "public"."appointments"
add constraint "appointments_professional_id_fkey"
foreign key (professional_id) references public.professionals(id)
on delete set null not valid;

alter table "public"."appointments"
validate constraint "appointments_professional_id_fkey";

create policy "members can read their orgs professionals"
on "public"."professionals"
as permissive
for select
to authenticated, anon
using (
  organization_id in (
    select public.get_authorized_orgs('member'::public.role)
  )
);

-- Admin para escrever: marcar horário é trabalho de quem atende, mas desligar
-- um profissional tira essa pessoa de toda a agenda futura.
create policy "admins can manage their orgs professionals"
on "public"."professionals"
as permissive
for all
to authenticated, anon
using (
  organization_id in (
    select public.get_authorized_orgs('admin'::public.role)
  )
);

create trigger set_updated_at
before update on public.professionals
for each row execute function public.moddatetime('updated_at');

create trigger set_extra
before update on public.professionals
for each row execute function public.merge_update('extra');
