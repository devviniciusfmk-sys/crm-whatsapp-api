-- Apagar campanha, descartando antes o que ela ainda não enviou.
-- Ver o comentário completo em schemas/04_functions_post_tables/04-04_campaigns.sql.
--
-- Editada à mão a partir do `db diff`, como as anteriores. O diff trouxe junto:
--   * 180 `revoke ... from anon/authenticated/service_role` sobre todas as
--     tabelas — a diferença conhecida entre o banco local e o de produção;
--     aplicar isso derrubaria o acesso do app inteiro;
--   * `get_authorized_orgs` e `hash_api_key` reescritas sem uma linha de
--     diferença, só porque o corpo delas está com CRLF no arquivo de schema.
-- Nada disso tem a ver com esta mudança, e foi retirado. - 2026/08/04

set check_function_bodies = off;

create or replace function public.delete_campaign(p_campaign_id uuid)
returns integer
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_campaign public.campaigns;
  v_discarded integer;
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

  if v_campaign.status = 'running'::public.campaign_status then
    raise exception 'campaign % is running; pause it before deleting',
      p_campaign_id;
  end if;

  delete from public.messages
  where campaign_id = p_campaign_id
    and status ->> 'accepted' is null
    and status ->> 'sent' is null
    and status ->> 'delivered' is null
    and status ->> 'read' is null
    and status ->> 'failed' is null;

  get diagnostics v_discarded = row_count;

  delete from public.campaigns
  where id = p_campaign_id;

  return v_discarded;
end;
$function$;
