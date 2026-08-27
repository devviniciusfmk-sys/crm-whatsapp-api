-- Escrita à mão, e não gerada por `supabase db diff`, de propósito: o diff
-- automático nesta rodada veio misturado com uma drift grande e não
-- relacionada (o remoto tem colunas/funções/view — `cobrancas.codigo_pix`,
-- `cobrancas.expira_em`, `iptv_testes.apps`, `painel_da_equipe`,
-- `painel_do_periodo`, `contact_overview` — que os arquivos de schema locais
-- não descrevem, e o diff propunha APAGAR tudo isso). Aplicar aquele arquivo
-- quebraria recursos em produção que não têm nada a ver com o funil de
-- vendas. Este arquivo contém só os objetos novos de `negocios`/leads
-- externos, extraídos manualmente do diff — nada de drop.

create table "public"."negocios" (
  "id" uuid not null default gen_random_uuid(),
  "organization_id" uuid not null,
  "externo_id" text,
  "origem" text not null default 'manual'::text,
  "nome" text not null,
  "telefone" text,
  "cidade" text,
  "categoria" text,
  "nicho" text,
  "estagio" text not null default 'novo'::text,
  "valor_estimado" numeric,
  "score_ia" real,
  "veredito_ia" text,
  "motivo_ia" text,
  "abertura_sugerida" text,
  "dores_identificadas" jsonb,
  "conversation_id" uuid,
  "extra" jsonb,
  "criado_em" timestamp with time zone not null default now(),
  "atualizado_em" timestamp with time zone not null default now()
);

alter table "public"."negocios" enable row level security;

CREATE INDEX negocios_estagio_idx ON public.negocios USING btree (organization_id, estagio);

CREATE UNIQUE INDEX negocios_externo_idx ON public.negocios USING btree (organization_id, origem, externo_id) WHERE (externo_id IS NOT NULL);

CREATE INDEX negocios_organization_id_idx ON public.negocios USING btree (organization_id);

CREATE UNIQUE INDEX negocios_pkey ON public.negocios USING btree (id);

alter table "public"."negocios" add constraint "negocios_pkey" PRIMARY KEY using index "negocios_pkey";

alter table "public"."negocios" add constraint "negocios_estagio_check" CHECK ((estagio = ANY (ARRAY['novo'::text, 'contatado'::text, 'qualificado'::text, 'proposta'::text, 'fechado'::text, 'perdido'::text]))) not valid;

alter table "public"."negocios" validate constraint "negocios_estagio_check";

alter table "public"."negocios" add constraint "negocios_organization_id_fkey" FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE not valid;

alter table "public"."negocios" validate constraint "negocios_organization_id_fkey";

grant references on table "public"."negocios" to "anon";
grant trigger on table "public"."negocios" to "anon";
grant truncate on table "public"."negocios" to "anon";

grant references on table "public"."negocios" to "authenticated";
grant trigger on table "public"."negocios" to "authenticated";
grant truncate on table "public"."negocios" to "authenticated";

grant references on table "public"."negocios" to "service_role";
grant trigger on table "public"."negocios" to "service_role";
grant truncate on table "public"."negocios" to "service_role";

create policy "members can manage their orgs negocios"
on "public"."negocios"
as permissive
for all
to authenticated, anon
using ((organization_id IN ( SELECT public.get_authorized_orgs('member'::public.role) AS get_authorized_orgs)));

CREATE TRIGGER set_extra BEFORE UPDATE ON public.negocios FOR EACH ROW WHEN ((new.extra IS NOT NULL)) EXECUTE FUNCTION public.merge_update('extra');

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.negocios FOR EACH ROW EXECUTE FUNCTION public.moddatetime('atualizado_em');

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.get_leads_externos_config()
 RETURNS TABLE(url text, secret_key text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select
    (select decrypted_secret from vault.decrypted_secrets where name = 'leads_externos_url'),
    (select decrypted_secret from vault.decrypted_secrets where name = 'leads_externos_secret_key');
$function$
;

revoke execute on function public.get_leads_externos_config()
from public, anon, authenticated;

grant execute on function public.get_leads_externos_config() to service_role;

CREATE OR REPLACE FUNCTION public.sincronizar_negocios_externos(p_linhas jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  _linhas_afetadas int;
begin
  with dados as (
    select * from jsonb_to_recordset(p_linhas) as x(
      organization_id uuid,
      externo_id text,
      origem text,
      nome text,
      telefone text,
      cidade text,
      categoria text,
      nicho text,
      score_ia real,
      veredito_ia text,
      motivo_ia text,
      abertura_sugerida text,
      dores_identificadas jsonb
    )
  )
  insert into public.negocios (
    organization_id, externo_id, origem, nome, telefone, cidade, categoria,
    nicho, score_ia, veredito_ia, motivo_ia, abertura_sugerida, dores_identificadas
  )
  select
    organization_id, externo_id, origem, nome, telefone, cidade, categoria,
    nicho, score_ia, veredito_ia, motivo_ia, abertura_sugerida, dores_identificadas
  from dados
  on conflict (organization_id, origem, externo_id) do update set
    nome = excluded.nome,
    telefone = excluded.telefone,
    cidade = excluded.cidade,
    categoria = excluded.categoria,
    nicho = excluded.nicho,
    score_ia = excluded.score_ia,
    veredito_ia = excluded.veredito_ia,
    motivo_ia = excluded.motivo_ia,
    abertura_sugerida = excluded.abertura_sugerida,
    dores_identificadas = excluded.dores_identificadas,
    atualizado_em = now();

  get diagnostics _linhas_afetadas = row_count;

  return _linhas_afetadas;
end;
$function$
;

revoke execute on function public.sincronizar_negocios_externos(jsonb)
from public, anon, authenticated;

grant execute on function public.sincronizar_negocios_externos(jsonb)
to service_role;
