-- Fecha as campanhas cuja fila esvaziou.
--
-- Gerada por `supabase db diff` e podada à mão: 168 linhas de `revoke` que são
-- artefato de privilégio padrão, não mudança de verdade.
--
-- Quem chama é o cron da migração seguinte. Sem isto, campanha fica em
-- `running` para sempre depois da última mensagem sair, e a tela mostra
-- "correndo" para coisa que acabou semana passada. - 2026/08/03

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.complete_finished_campaigns()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_completed integer;
begin
  update public.campaigns as c
  set status = 'completed'::public.campaign_status,
      completed_at = now()
  where c.status = 'running'::public.campaign_status
    and not exists (
      select 1
      from public.messages as m
      where m.campaign_id = c.id
        and m.timestamp >= now() - interval '12 hours'
        and m.status ->> 'accepted' is null
        and m.status ->> 'sent' is null
        and m.status ->> 'delivered' is null
        and m.status ->> 'read' is null
        and m.status ->> 'failed' is null
    );

  get diagnostics v_completed = row_count;

  return v_completed;
end;
$function$
;


