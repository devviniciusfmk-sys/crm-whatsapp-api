-- Separa o público da campanha numa função própria, e conta esse público.
--
-- Gerada por `supabase db diff` e podada à mão (168 linhas de `revoke` que são
-- artefato de privilégio padrão).
--
-- `campaign_recipients` sai de dentro de `start_campaign` para que a prévia na
-- tela e o disparo usem exatamente o mesmo critério. Dizer "vai para 3.412
-- pessoas" e mandar para 2.900 é o tipo de divergência que aparece meses
-- depois, quando alguém mexe num dos dois lados e esquece o outro.
--
-- `count_campaign_audience` é essa mesma lista, contada, em nível `member` —
-- quem atende pode conferir o alcance antes de pedir o disparo. - 2026/08/04

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.campaign_recipients(p_campaign public.campaigns)
 RETURNS TABLE(contact_address text, conversation_id uuid, content jsonb)
 LANGUAGE sql
 STABLE
AS $function$
  select distinct on (ca.address)
    ca.address,
    conv.id,
    rendered.content
  from public.contacts_addresses as ca
  join public.contacts as c
    on c.id = ca.contact_id
  join public.conversations as conv
    on conv.organization_id = ca.organization_id
   and conv.service = ca.service
   and conv.contact_address = ca.address
   and conv.organization_address = p_campaign.organization_address
  cross join lateral (
    select public.render_campaign_template(p_campaign, c) as content
  ) as rendered
  where ca.organization_id = p_campaign.organization_id
    and ca.service = p_campaign.service
    and ca.status = 'active'
    and (
      p_campaign.template_category <> 'marketing'
      or ca.marketing_opt_out_at is null
    )
    and public.matches_campaign_audience(c, p_campaign.audience)
    and rendered.content is not null
  order by ca.address, conv.updated_at desc;
$function$
;

CREATE OR REPLACE FUNCTION public.count_campaign_audience(p_campaign_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_campaign public.campaigns;
  v_count integer;
begin
  select * into v_campaign
  from public.campaigns
  where id = p_campaign_id
    and organization_id in (select public.get_authorized_orgs('member'));

  if not found then
    raise exception 'campaign not found or not authorized'
      using errcode = 'insufficient_privilege';
  end if;

  select count(*) into v_count
  from public.campaign_recipients(v_campaign);

  return v_count;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.start_campaign(p_campaign_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_campaign public.campaigns;
  v_inserted integer;
begin
  select * into v_campaign
  from public.campaigns
  where id = p_campaign_id
    and organization_id in (select public.get_authorized_orgs('admin'))
  for update;

  if not found then
    raise exception 'campaign not found or not authorized'
      using errcode = 'insufficient_privilege';
  end if;

  if v_campaign.status not in (
    'draft'::public.campaign_status,
    'scheduled'::public.campaign_status,
    'paused'::public.campaign_status
  ) then
    raise exception 'campaign % is %; only draft, scheduled or paused can start',
      p_campaign_id, v_campaign.status;
  end if;

  insert into public.messages (
    organization_id,
    conversation_id,
    campaign_id,
    direction,
    service,
    organization_address,
    contact_address,
    content,
    timestamp
  )
  select
    v_campaign.organization_id,
    r.conversation_id,
    v_campaign.id,
    'outgoing'::public.direction,
    v_campaign.service,
    v_campaign.organization_address,
    r.contact_address,
    r.content,
    coalesce(v_campaign.scheduled_at, now())
  from public.campaign_recipients(v_campaign) as r
  on conflict (campaign_id, contact_address) where campaign_id is not null
  do nothing;

  get diagnostics v_inserted = row_count;

  update public.campaigns
  set status = 'running'::public.campaign_status,
      started_at = coalesce(started_at, now())
  where id = p_campaign_id;

  return v_inserted;
end;
$function$
;


