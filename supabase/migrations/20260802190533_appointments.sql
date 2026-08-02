-- Compromissos marcados com um contato.
--
-- Gerada por `supabase db diff` e podada à mão, como o README avisa. O diff
-- trouxe junto um `revoke` de select/insert/update/delete em todas as tabelas
-- e a recriação de funções que só diferem por CRLF — nada disso é mudança de
-- verdade, e aplicar os revokes tiraria do PostgREST a permissão de ler
-- qualquer tabela.
--
-- Os grants abaixo estão à mão pelo mesmo motivo: com os revokes fora, o diff
-- só concede references/trigger/truncate, e a tabela nasceria ilegível. Os
-- privilégios repetem exatamente os que as outras tabelas já têm.
-- - 2026/08/02

create type "public"."appointment_status" as enum ('scheduled', 'done', 'cancelled', 'no_show');

create table "public"."appointments" (
  "id" uuid not null default gen_random_uuid(),
  "organization_id" uuid not null,
  "service" public.service not null,
  "organization_address" text not null,
  "contact_address" text not null,
  "conversation_id" uuid,
  "title" text not null,
  "starts_at" timestamp with time zone not null,
  "duration_minutes" integer,
  "status" public.appointment_status not null default 'scheduled'::public.appointment_status,
  "notes" text,
  "external_id" text,
  "extra" jsonb not null default '{}'::jsonb,
  "created_at" timestamp with time zone not null default now(),
  "updated_at" timestamp with time zone not null default now()
);

alter table "public"."appointments" enable row level security;

CREATE UNIQUE INDEX appointments_pkey ON public.appointments USING btree (id);

CREATE INDEX appointments_organization_starts_at_idx ON public.appointments USING btree (organization_id, starts_at);

alter table "public"."appointments" add constraint "appointments_pkey" PRIMARY KEY using index "appointments_pkey";

alter table "public"."appointments" add constraint "appointments_organization_id_fkey" FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE not valid;

alter table "public"."appointments" validate constraint "appointments_organization_id_fkey";

alter table "public"."appointments" add constraint "appointments_conversation_id_fkey" FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE SET NULL not valid;

alter table "public"."appointments" validate constraint "appointments_conversation_id_fkey";

grant delete, insert, references, select, trigger, truncate, update on table "public"."appointments" to "anon";

grant delete, insert, references, select, trigger, truncate, update on table "public"."appointments" to "authenticated";

grant delete, insert, references, select, trigger, truncate, update on table "public"."appointments" to "service_role";

create policy "members can read their orgs appointments"
on "public"."appointments"
as permissive
for select
to authenticated, anon
using ((organization_id IN ( SELECT public.get_authorized_orgs('member'::public.role) AS get_authorized_orgs)));

create policy "members can manage their orgs appointments"
on "public"."appointments"
as permissive
for all
to authenticated, anon
using ((organization_id IN ( SELECT public.get_authorized_orgs('member'::public.role) AS get_authorized_orgs)));

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.appointments FOR EACH ROW EXECUTE FUNCTION public.moddatetime('updated_at');

CREATE TRIGGER set_extra BEFORE UPDATE ON public.appointments FOR EACH ROW EXECUTE FUNCTION public.merge_update('extra');
