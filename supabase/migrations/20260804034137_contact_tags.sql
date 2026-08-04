-- Etiquetas no contato, e o público da campanha passa a ser por etiqueta.
--
-- Gerada por `supabase db diff` e podada à mão (as linhas de `revoke` são
-- artefato de privilégio padrão, não mudança de verdade).
--
-- O `audience` da campanha filtrava por cidade, estado e "tem e-mail". Era um
-- vocabulário tirado das colunas que a ficha tinha, não de como alguém pensa um
-- disparo: ninguém quer falar com "quem tem e-mail preenchido em Pelotas",
-- quer falar com "os VIP" ou "quem sumiu". Isso é etiqueta — e é o que as
-- ferramentas do ramo usam, herdando as etiquetas do WhatsApp Business.
--
-- A troca cabe numa migração só porque nada disso está em produção ainda: o
-- vocabulário antigo nunca chegou a existir fora do banco local. - 2026/08/04









































































































































































alter table "public"."contacts" add column "tags" text[] not null default '{}'::text[];

CREATE INDEX contacts_tags_idx ON public.contacts USING gin (tags);

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.count_audience(p_organization_id uuid, p_organization_address text, p_template_category text, p_audience jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_campaign public.campaigns;
  v_count integer;
begin
  if p_organization_id not in (select public.get_authorized_orgs('member')) then
    raise exception 'not authorized'
      using errcode = 'insufficient_privilege';
  end if;

  v_campaign.organization_id := p_organization_id;
  v_campaign.organization_address := p_organization_address;
  v_campaign.service := 'whatsapp'::public.service;
  v_campaign.template_category := p_template_category;
  v_campaign.template_name := '';
  v_campaign.template_language := '';
  v_campaign.variables := '{}'::jsonb;
  v_campaign.audience := coalesce(p_audience, '{}'::jsonb);

  select count(*) into v_count
  from public.campaign_recipients(v_campaign);

  return v_count;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.organization_tags(p_organization_id uuid)
 RETURNS TABLE(tag text, contacts integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select tag, count(*)::integer
  from public.contacts as c
  cross join lateral unnest(c.tags) as tag
  where c.organization_id = p_organization_id
    and c.organization_id in (select public.get_authorized_orgs('member'))
  group by tag
  order by count(*) desc, tag;
$function$
;

CREATE OR REPLACE FUNCTION public.matches_campaign_audience(p_contact public.contacts, p_audience jsonb)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  select
    (
      not p_audience ? 'contact_ids'
      or p_contact.id::text in (
        select jsonb_array_elements_text(p_audience -> 'contact_ids')
      )
    )
    and (
      not p_audience ? 'tags'
      or jsonb_array_length(p_audience -> 'tags') = 0
      or case coalesce(p_audience ->> 'match', 'any')
        when 'all' then p_contact.tags @> (
          select array_agg(value)
          from jsonb_array_elements_text(p_audience -> 'tags') as value
        )
        else p_contact.tags && (
          select array_agg(value)
          from jsonb_array_elements_text(p_audience -> 'tags') as value
        )
      end
    )
    and (
      not p_audience ? 'status'
      or p_contact.status = p_audience ->> 'status'
    );
$function$
;


