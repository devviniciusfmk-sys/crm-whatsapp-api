-- Cancela uma mensagem agendada que ainda não saiu.
--
-- Gerada por `supabase db diff` e podada à mão, como o README avisa que às
-- vezes é preciso. O diff trouxe junto um `revoke` de select/insert/update/
-- delete em todas as tabelas para anon, authenticated e service_role, mais a
-- recriação de get_authorized_orgs e hash_api_key só porque o corpo delas está
-- gravado com CRLF no banco e com LF no arquivo.
--
-- Nada disso é mudança de verdade: os grants vêm da migração
-- 20250821133823_declarative_schemas_limitations, que o esquema declarativo não
-- consegue expressar, e aplicá-los aqui tiraria do PostgREST a permissão de ler
-- qualquer tabela — derrubaria o produto inteiro. Ficou só a função nova.
-- - 2026/08/02
set check_function_bodies = off;

create or replace function public.cancel_scheduled_message(p_message_id uuid)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
begin
  delete from public.messages
  where id = p_message_id
    and organization_id in (select public.get_authorized_orgs('member'))
    and direction = 'outgoing'::public.direction
    and timestamp > now()
    and status ? 'pending'
    and not (status ?| array['accepted', 'sent', 'delivered', 'read', 'failed']);

  if not found then
    raise exception 'scheduled message not found, already sent, or not authorized'
      using errcode = 'insufficient_privilege';
  end if;
end;
$function$;
