
-- ## A chave da ElevenLabs, no mesmo trato da chave do modelo
--
-- Mesma forma, e de propósito: sem leitor para o navegador, gravada por
-- cima, apagada com vazio. Chave que a interface consegue ler é chave que
-- vaza pelo primeiro `console.log` de quem for depurar outra coisa.
--
-- É de CADA loja, e não uma do produto. Quem gasta paga: gerar áudio custa
-- por caractere, e uma chave compartilhada faria a fatura de uma loja que
-- abusa cair no colo de todas as outras. - 2026/08/22
create or replace function public.voz_key_secret_name(p_organization_id uuid)
returns text
language sql
immutable
set search_path to ''
as $$
  select 'voz_key:' || p_organization_id::text;
$$;

revoke execute on function public.voz_key_secret_name(uuid)
from public, anon, authenticated;

-- Só o service_role lê: quem chama é a função de borda que gera o áudio.
create or replace function public.get_voz_api_key(p_organization_id uuid)
returns text
language sql
stable
security definer
set search_path to ''
as $$
  select s.decrypted_secret
  from vault.decrypted_secrets s
  where s.name = public.voz_key_secret_name(p_organization_id);
$$;

revoke execute on function public.get_voz_api_key(uuid)
from public, anon, authenticated;

grant execute on function public.get_voz_api_key(uuid) to service_role;

-- A tela só pergunta se existe. Nunca o valor.
create or replace function public.has_voz_api_key(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path to ''
as $$
  select exists (
    select 1 from vault.secrets
    where name = public.voz_key_secret_name(p_organization_id)
      and p_organization_id in (select public.get_authorized_orgs('member'))
  );
$$;

revoke execute on function public.has_voz_api_key(uuid) from public, anon;
grant execute on function public.has_voz_api_key(uuid) to authenticated;

create or replace function public.set_voz_api_key(
  p_organization_id uuid,
  p_key text
)
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
  _name text := public.voz_key_secret_name(p_organization_id);
  _id uuid;
begin
  if p_organization_id not in (select public.get_authorized_orgs('admin')) then
    raise exception 'not authorized to set the voice key'
      using errcode = 'insufficient_privilege';
  end if;

  -- Vazio apaga: é o caminho de volta para quem quiser desligar a voz sem
  -- pedir para ninguém.
  if nullif(p_key, '') is null then
    delete from vault.secrets where name = _name;
    return;
  end if;

  select id into _id from vault.secrets where name = _name;

  if _id is null then
    perform vault.create_secret(
      p_key,
      _name,
      'ElevenLabs API key for organization ' || p_organization_id::text
    );
  else
    perform vault.update_secret(_id, p_key);
  end if;
end;
$$;

revoke execute on function public.set_voz_api_key(uuid, text) from public, anon;
grant execute on function public.set_voz_api_key(uuid, text) to authenticated;
