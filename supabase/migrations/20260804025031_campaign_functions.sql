-- As três funções que transformam uma campanha em mensagens.
--
-- Gerada por `supabase db diff` e podada à mão: o diff trouxe junto 168 linhas
-- de `revoke` em todas as tabelas, que são artefato de privilégio padrão e não
-- mudança de verdade. Aqui não há grant a repor — diferente da migração da
-- tabela, nenhuma tabela nova é criada.
--
-- `start_campaign` materializa o público num único `insert ... select`, com
-- `on conflict do nothing` sobre o índice parcial
-- `messages_campaign_recipient_key` — que é a idempotência inteira do disparo.
--
-- `render_campaign_template` devolve NULL quando uma variável não tem valor nem
-- reserva, e o `where` descarta esse destinatário. Template com parâmetro vazio
-- ou é recusado pela Meta (132000) ou chega como "Olá , tudo bem?".
--
-- Nada aqui dispara sozinho: a campanha só sai quando alguém chamar
-- `start_campaign`, e mesmo então quem entrega é a fila de
-- `claim_pending_messages`, no ritmo do número. - 2026/08/03

set check_function_bodies = off;

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
      not p_audience ? 'status'
      or p_contact.status = p_audience ->> 'status'
    )
    and (
      not p_audience ? 'city'
      or lower(p_contact.extra ->> 'city') = lower(p_audience ->> 'city')
    )
    and (
      not p_audience ? 'state'
      or upper(p_contact.extra ->> 'state') = upper(p_audience ->> 'state')
    )
    and (
      not p_audience ? 'has_email'
      or (p_contact.extra ->> 'email' is not null)
         = (p_audience ->> 'has_email')::boolean
    )
    and (
      not p_audience ? 'created_after'
      or p_contact.created_at >= (p_audience ->> 'created_after')::timestamptz
    );
$function$
;

CREATE OR REPLACE FUNCTION public.render_campaign_template(p_campaign public.campaigns, p_contact public.contacts)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
AS $function$
declare
  v_sections text[] := array['header', 'body'];
  v_section text;
  v_spec jsonb;
  v_slot jsonb;
  v_params jsonb;
  v_value text;
  v_components jsonb := '[]'::jsonb;
begin
  foreach v_section in array v_sections
  loop
    v_spec := p_campaign.variables -> v_section;

    if v_spec is null or jsonb_typeof(v_spec) <> 'array'
       or jsonb_array_length(v_spec) = 0 then
      continue;
    end if;

    v_params := '[]'::jsonb;

    for v_slot in select jsonb_array_elements(v_spec)
    loop
      if v_slot ? 'literal' then
        v_value := v_slot ->> 'literal';
      elsif (v_slot ->> 'from') = 'contact.name' then
        v_value := p_contact.name;
      elsif (v_slot ->> 'from') like 'contact.%' then
        v_value := p_contact.extra ->> substr(v_slot ->> 'from', 9);
      else
        v_value := null;
      end if;

      if v_value is null or btrim(v_value) = '' then
        v_value := v_slot ->> 'fallback';
      end if;

      -- sem valor e sem reserva: este destinatário não recebe nada
      if v_value is null or btrim(v_value) = '' then
        return null;
      end if;

      v_value := btrim(regexp_replace(v_value, '[\n\r\t]+', ' ', 'g'));

      v_params := v_params
        || jsonb_build_object('type', 'text', 'text', v_value);
    end loop;

    v_components := v_components
      || jsonb_build_object('type', v_section, 'parameters', v_params);
  end loop;

  return jsonb_build_object(
    'version', '1',
    'type', 'data',
    'kind', 'template',
    'data',
      jsonb_build_object(
        'name', p_campaign.template_name,
        'language', jsonb_build_object(
          'code', p_campaign.template_language,
          'policy', 'deterministic'
        )
      )
      || case
           when jsonb_array_length(v_components) > 0
             then jsonb_build_object('components', v_components)
           else '{}'::jsonb
         end
  );
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
  select distinct on (ca.address)
    v_campaign.organization_id,
    conv.id,
    v_campaign.id,
    'outgoing'::public.direction,
    v_campaign.service,
    v_campaign.organization_address,
    ca.address,
    rendered.content,
    coalesce(v_campaign.scheduled_at, now())
  from public.contacts_addresses as ca
  join public.contacts as c
    on c.id = ca.contact_id
  join public.conversations as conv
    on conv.organization_id = ca.organization_id
   and conv.service = ca.service
   and conv.contact_address = ca.address
   and conv.organization_address = v_campaign.organization_address
  cross join lateral (
    select public.render_campaign_template(v_campaign, c) as content
  ) as rendered
  where ca.organization_id = v_campaign.organization_id
    and ca.service = v_campaign.service
    and ca.status = 'active'
    and (
      v_campaign.template_category <> 'marketing'
      or ca.marketing_opt_out_at is null
    )
    and public.matches_campaign_audience(c, v_campaign.audience)
    and rendered.content is not null
  order by ca.address, conv.updated_at desc
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


