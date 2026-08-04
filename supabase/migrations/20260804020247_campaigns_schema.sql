-- Campanhas: disparo de template aprovado para uma lista de contatos.
--
-- Gerada por `supabase db diff` e podada à mão, como o README avisa. O diff
-- trouxe junto 156 linhas de `revoke` de select/insert/update/delete em todas
-- as tabelas — nada disso é mudança de verdade, e aplicar os revokes tiraria do
-- PostgREST a permissão de ler qualquer tabela.
--
-- Os grants abaixo estão à mão pelo mesmo motivo: com os revokes fora, o diff
-- só concede references/trigger/truncate, e a tabela nasceria ilegível. Os
-- privilégios repetem exatamente os que as outras tabelas já têm.
--
-- Nada aqui muda comportamento. A tabela nasce vazia, ninguém a lê ainda, e as
-- duas guardas `campaign_id is null` acrescentadas aos gatilhos de `messages`
-- são no-op enquanto nenhuma mensagem tiver campanha. A materialização do
-- público e o runner em lote vêm depois. - 2026/08/03

create type "public"."campaign_status" as enum ('draft', 'scheduled', 'running', 'paused', 'completed', 'canceled');

create table "public"."campaigns" (
  "id" uuid not null default gen_random_uuid(),
  "organization_id" uuid not null,
  "organization_address" text not null,
  "service" public.service not null default 'whatsapp'::public.service,
  "name" text not null,
  "template_name" text not null,
  "template_language" text not null,
  "template_category" text not null,
  "variables" jsonb not null default '{}'::jsonb,
  "audience" jsonb not null default '{}'::jsonb,
  "status" public.campaign_status not null default 'draft'::public.campaign_status,
  "throughput_mps" integer not null default 20,
  "scheduled_at" timestamp with time zone,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "created_by" uuid,
  "extra" jsonb not null default '{}'::jsonb,
  "created_at" timestamp with time zone not null default now(),
  "updated_at" timestamp with time zone not null default now()
);

alter table "public"."campaigns" enable row level security;

alter table "public"."contacts_addresses" add column "marketing_opt_out_at" timestamp with time zone;

alter table "public"."messages" add column "campaign_id" uuid;

CREATE UNIQUE INDEX campaigns_pkey ON public.campaigns USING btree (id);

CREATE INDEX campaigns_organization_id_idx ON public.campaigns USING btree (organization_id);

CREATE INDEX campaigns_running_idx ON public.campaigns USING btree (organization_address) WHERE (status = 'running'::public.campaign_status);

-- A garantia de não enviar duas vezes: materializar de novo é `on conflict do
-- nothing`, e não há lógica de deduplicação em lugar nenhum.
CREATE UNIQUE INDEX messages_campaign_recipient_key ON public.messages USING btree (campaign_id, contact_address) WHERE (campaign_id IS NOT NULL);

CREATE INDEX messages_campaign_id_idx ON public.messages USING btree (campaign_id) WHERE (campaign_id IS NOT NULL);

alter table "public"."campaigns" add constraint "campaigns_pkey" PRIMARY KEY using index "campaigns_pkey";

alter table "public"."campaigns" add constraint "campaigns_organization_id_fkey" FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE not valid;

alter table "public"."campaigns" validate constraint "campaigns_organization_id_fkey";

alter table "public"."campaigns" add constraint "campaigns_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL not valid;

alter table "public"."campaigns" validate constraint "campaigns_created_by_fkey";

alter table "public"."campaigns" add constraint "campaigns_template_category_check" CHECK ((template_category = ANY (ARRAY['marketing'::text, 'utility'::text, 'authentication'::text]))) not valid;

alter table "public"."campaigns" validate constraint "campaigns_template_category_check";

alter table "public"."campaigns" add constraint "campaigns_throughput_mps_check" CHECK (((throughput_mps >= 1) AND (throughput_mps <= 80))) not valid;

alter table "public"."campaigns" validate constraint "campaigns_throughput_mps_check";

alter table "public"."messages" add constraint "messages_campaign_id_fkey" FOREIGN KEY (campaign_id) REFERENCES public.campaigns(id) ON DELETE SET NULL not valid;

alter table "public"."messages" validate constraint "messages_campaign_id_fkey";

grant delete, insert, references, select, trigger, truncate, update on table "public"."campaigns" to "anon";

grant delete, insert, references, select, trigger, truncate, update on table "public"."campaigns" to "authenticated";

grant delete, insert, references, select, trigger, truncate, update on table "public"."campaigns" to "service_role";

create policy "members can read their orgs campaigns"
on "public"."campaigns"
as permissive
for select
to authenticated, anon
using ((organization_id IN ( SELECT public.get_authorized_orgs('member'::public.role) AS get_authorized_orgs)));

create policy "admins can manage their orgs campaigns"
on "public"."campaigns"
as permissive
for all
to authenticated, anon
using ((organization_id IN ( SELECT public.get_authorized_orgs('admin'::public.role) AS get_authorized_orgs)));

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.campaigns FOR EACH ROW EXECUTE FUNCTION public.moddatetime('updated_at');

CREATE TRIGGER set_extra BEFORE UPDATE ON public.campaigns FOR EACH ROW EXECUTE FUNCTION public.merge_update('extra');

-- Os dois gatilhos abaixo já existiam; ganham `campaign_id is null` na cláusula
-- `when`. Postgres não altera o `when` de um gatilho, então é drop e recria —
-- dentro da transação da migração, sem janela visível para outras sessões.
--
-- Sem a primeira guarda, o `insert ... select` de uma campanha chamaria o
-- dispatcher uma vez por linha e contornaria a fila inteira. Sem a segunda, o
-- disparo pausaria todas as conversas atingidas e o agente pararia de responder
-- a base.
drop trigger if exists "handle_outgoing_message_to_dispatcher" on "public"."messages";

CREATE TRIGGER handle_outgoing_message_to_dispatcher AFTER INSERT ON public.messages FOR EACH ROW WHEN (((new.direction = 'outgoing'::public.direction) AND (new.campaign_id IS NULL) AND (new."timestamp" <= now()) AND ((new.status ->> 'pending'::text) IS NOT NULL))) EXECUTE FUNCTION public.dispatcher_edge_function();

drop trigger if exists "pause_conversation_on_human_message" on "public"."messages";

CREATE TRIGGER pause_conversation_on_human_message AFTER INSERT ON public.messages FOR EACH ROW WHEN (((new.direction = 'outgoing'::public.direction) AND (new.campaign_id IS NULL) AND (new.service <> 'local'::public.service) AND (new."timestamp" <= now()) AND (new."timestamp" >= (now() - '00:00:10'::interval)))) EXECUTE FUNCTION public.pause_conversation_on_human_message();

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.claim_pending_messages(p_budget_per_address integer DEFAULT 1200)
 RETURNS SETOF public.messages
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with eligible as (
    select
      m.id,
      row_number() over (
        partition by m.organization_address
        order by (m.campaign_id is not null), m.timestamp
      ) as position
    from public.messages as m
    left join public.campaigns as c
      on c.id = m.campaign_id
    where m.direction = 'outgoing'::public.direction
      and m.timestamp >= now() - interval '12 hours'
      and m.timestamp <= now() - interval '1 minutes'
      and m.status ->> 'pending' is not null
      and m.status ->> 'held_for_quality_assessment' is null
      and m.status ->> 'accepted' is null
      and m.status ->> 'sent' is null
      and m.status ->> 'delivered' is null
      and m.status ->> 'read' is null
      and m.status ->> 'failed' is null
      and (
        m.status ->> 'claimed' is null
        or (m.status ->> 'claimed')::timestamptz < now() - interval '5 minutes'
      )
      and (
        m.campaign_id is null
        or c.status = 'running'::public.campaign_status
      )
  ),
  locked as (
    select p.id
    from public.messages as p
    where p.id in (
      select e.id
      from eligible as e
      where e.position <= p_budget_per_address
    )
    for update skip locked
  )
  update public.messages as m
  set status = jsonb_build_object('claimed', now())
  from locked as l
  where m.id = l.id
  returning m.*;
$function$
;
