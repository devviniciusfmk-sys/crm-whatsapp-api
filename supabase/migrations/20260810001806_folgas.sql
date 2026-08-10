-- Folgas: quando NÃO se atende, fora do que a semana já diz.
--
-- Gerada por `supabase db diff` e podada à mão, como as duas anteriores: o diff
-- traz 168 `revoke` em todas as tabelas do sistema, diferença entre as
-- concessões da produção e as declaradas nos arquivos de esquema, e aplicá-las
-- tiraria o acesso do aplicativo inteiro. Sobrou o que esta migração é.
--
-- Desta vez os `grant` FICAM. Na migração de `professionals` eu os podei junto
-- com o ruído, confiando nos privilégios padrão — e a tabela respondia em
-- produção e falhava no banco local. Permissão de tabela é parte da migração,
-- não detalhe de ambiente. - 2026/08/09

create table "public"."time_off" (
  "id" uuid not null default gen_random_uuid(),
  "organization_id" uuid not null,
  -- Nulo é a LOJA INTEIRA: feriado, reforma, fechamento.
  "professional_id" uuid,
  "starts_at" timestamp with time zone not null,
  "ends_at" timestamp with time zone not null,
  "reason" text,
  "extra" jsonb not null default '{}'::jsonb,
  "created_at" timestamp with time zone not null default now(),
  "updated_at" timestamp with time zone not null default now()
);

alter table "public"."time_off" enable row level security;

create unique index time_off_pkey on public.time_off using btree (id);

create index time_off_organization_starts_at_idx
on public.time_off using btree (organization_id, starts_at);

alter table "public"."time_off"
add constraint "time_off_pkey" primary key using index "time_off_pkey";

alter table "public"."time_off"
add constraint "time_off_ends_after_it_starts" check ((ends_at > starts_at))
not valid;

alter table "public"."time_off"
validate constraint "time_off_ends_after_it_starts";

alter table "public"."time_off"
add constraint "time_off_organization_id_fkey"
foreign key (organization_id) references public.organizations(id)
on delete cascade not valid;

alter table "public"."time_off"
validate constraint "time_off_organization_id_fkey";

-- `cascade`, e não `set null`: aqui nulo significa "a loja inteira", então
-- esvaziar a coluna transformaria a folga de quem saiu num feriado da casa.
alter table "public"."time_off"
add constraint "time_off_professional_id_fkey"
foreign key (professional_id) references public.professionals(id)
on delete cascade not valid;

alter table "public"."time_off"
validate constraint "time_off_professional_id_fkey";

grant select, insert, update, delete on table "public"."time_off" to "anon";
grant select, insert, update, delete on table "public"."time_off" to "authenticated";
grant select, insert, update, delete on table "public"."time_off" to "service_role";

create policy "members can read their orgs time off"
on "public"."time_off"
as permissive
for select
to authenticated, anon
using (
  organization_id in (
    select public.get_authorized_orgs('member'::public.role)
  )
);

-- Membro, e não admin: bloquear horário é ato de atendimento, igual a marcar.
create policy "members can manage their orgs time off"
on "public"."time_off"
as permissive
for all
to authenticated, anon
using (
  organization_id in (
    select public.get_authorized_orgs('member'::public.role)
  )
);

create trigger set_updated_at
before update on public.time_off
for each row execute function public.moddatetime('updated_at');

create trigger set_extra
before update on public.time_off
for each row execute function public.merge_update('extra');
