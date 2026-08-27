-- Escrita à mão pelo mesmo motivo do arquivo anterior: `db diff` neste
-- projeto vem misturado com uma drift grande e não relacionada entre os
-- arquivos de schema e o histórico de migrações já aplicado.
create function public.set_vault_secret(p_name text, p_value text)
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
  _id uuid;
begin
  if p_name not in (
    'edge_functions_url', 'edge_functions_token',
    'leads_externos_url', 'leads_externos_secret_key'
  ) then
    raise exception 'set_vault_secret: nome de segredo não reconhecido: %', p_name;
  end if;

  select id into _id from vault.secrets where name = p_name;

  if _id is null then
    perform vault.create_secret(p_value, p_name, 'platform secret: ' || p_name);
  else
    perform vault.update_secret(_id, p_value);
  end if;
end;
$$;

revoke execute on function public.set_vault_secret(text, text)
from public, anon, authenticated;

grant execute on function public.set_vault_secret(text, text) to service_role;
