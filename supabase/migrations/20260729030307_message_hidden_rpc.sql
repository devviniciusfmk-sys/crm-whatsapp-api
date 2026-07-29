set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.set_message_hidden(p_message_id uuid, p_hidden boolean DEFAULT true)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  update public.messages
  set status = jsonb_build_object('hidden', case when p_hidden then now() end)
  where id = p_message_id
    and organization_id in (select public.get_authorized_orgs('member'));

  if not found then
    raise exception 'message not found or not authorized'
      using errcode = 'insufficient_privilege';
  end if;
end;
$function$
;


