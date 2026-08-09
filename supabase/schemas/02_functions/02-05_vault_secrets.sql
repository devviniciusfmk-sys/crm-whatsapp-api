-- Meta (WhatsApp) access tokens live in Supabase Vault, never in
-- `organizations_addresses.extra`. The jsonb column is readable by every member
-- of the org through the "members can read their orgs addresses" RLS policy —
-- and it is also shipped verbatim to customer webhooks by `notify_webhook`
-- (`to_jsonb(new)`), so a token stored there is effectively public to the org.
--
-- Secrets are keyed by a deterministic name derived from the address' primary
-- key, so no extra lookup table is needed:
--
--   wa_token:<organization_id>:<address>
--
-- Only `service_role` may call the accessors; `authenticated`/`anon` are
-- revoked explicitly because `create function` grants execute to `public` by
-- default.

create function public.whatsapp_token_secret_name(
  p_organization_id uuid,
  p_address text
) returns text
language sql
immutable
set search_path to ''
as $$
  select 'wa_token:' || p_organization_id::text || ':' || p_address;
$$;

revoke execute on function public.whatsapp_token_secret_name(uuid, text)
from public, anon, authenticated;

create function public.get_whatsapp_access_token(
  p_organization_id uuid,
  p_address text
) returns text
language sql
stable
security definer
set search_path to ''
as $$
  select s.decrypted_secret
  from vault.decrypted_secrets s
  where s.name = public.whatsapp_token_secret_name(p_organization_id, p_address);
$$;

revoke execute on function public.get_whatsapp_access_token(uuid, text)
from public, anon, authenticated;

grant execute on function public.get_whatsapp_access_token(uuid, text)
to service_role;

create function public.set_whatsapp_access_token(
  p_organization_id uuid,
  p_address text,
  p_token text
) returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
  _name text := public.whatsapp_token_secret_name(p_organization_id, p_address);
  _id uuid;
begin
  if nullif(p_token, '') is null then
    raise exception 'set_whatsapp_access_token: token must not be null or empty';
  end if;

  -- `vault.secrets.name` is unique, so this is an upsert by name. Read from
  -- `vault.secrets` (not `decrypted_secrets`) — id/name are plaintext columns
  -- and there is no reason to decrypt just to test for existence.
  select id into _id from vault.secrets where name = _name;

  if _id is null then
    perform vault.create_secret(
      p_token,
      _name,
      'Meta access token for whatsapp address ' || p_address
    );
  else
    perform vault.update_secret(_id, p_token);
  end if;
end;
$$;

revoke execute on function
  public.set_whatsapp_access_token(uuid, text, text)
from public, anon, authenticated;

grant execute on function public.set_whatsapp_access_token(uuid, text, text)
to service_role;

create function public.delete_whatsapp_access_token(
  p_organization_id uuid,
  p_address text
) returns void
language sql
security definer
set search_path to ''
as $$
  delete from vault.secrets
  where name = public.whatsapp_token_secret_name(p_organization_id, p_address);
$$;

revoke execute on function public.delete_whatsapp_access_token(uuid, text)
from public, anon, authenticated;

grant execute on function public.delete_whatsapp_access_token(uuid, text)
to service_role;

-- Without this the secret outlives the row: `organizations_addresses` is
-- deleted by cascade when an organization is removed, and Instagram-style data
-- deletion requests delete the row directly.
create function public.drop_whatsapp_access_token_on_delete() returns trigger
language plpgsql
security definer
set search_path to ''
as $$
begin
  perform public.delete_whatsapp_access_token(old.organization_id, old.address);

  return old;
end;
$$;

-- Postgres already refuses a direct call ("trigger functions can only be called
-- as triggers"), but keep the ACL consistent with the accessors above.
revoke execute on function public.drop_whatsapp_access_token_on_delete()
from public, anon, authenticated;

-- A chave do provedor de modelo, no cofre e por organização.
--
-- Ela morava em `agents.extra.api_key`, uma coluna jsonb — e a política
-- "members can read their orgs agents" deixa qualquer atendente da organização
-- lê-la. O barbeiro contratado para responder mensagens tinha acesso ao crédito
-- de IA da conta. É a mesma armadilha que o token da Meta já tinha, e o
-- comentário de `whatsapp_token_secret_name` a descreve com todas as letras:
-- coluna jsonb é lida por todo mundo da organização e vai verbatim para
-- webhooks de cliente.
--
-- Por organização, e não por agente, por dois motivos. A chave é da conta, não
-- do comportamento: o agente diz o que fazer, a chave é como se paga. E apagar
-- um agente levava a chave junto — aconteceu aqui, e o assistente seguinte
-- nasceu sem com que rodar. Com a chave na organização, todo assistente novo já
-- nasce funcionando, que é o que o preenchimento por ramo precisa para ser
-- "pronto ao usuário".
--
-- O nome é derivado da organização, então não há tabela de apoio:
--
--   model_key:<organization_id>
--
-- Não existe leitor para o navegador, de propósito. A tela pergunta se está
-- configurada e grava por cima; ninguém devolve o valor. Chave que a interface
-- consegue ler é chave que vaza pelo primeiro `console.log`. - 2026/08/05
create function public.model_key_secret_name(p_organization_id uuid)
returns text
language sql
immutable
set search_path to ''
as $$
  select 'model_key:' || p_organization_id::text;
$$;

revoke execute on function public.model_key_secret_name(uuid)
from public, anon, authenticated;

-- Só o service_role lê o valor: quem chama é a função de borda do assistente.
create function public.get_model_api_key(p_organization_id uuid)
returns text
language sql
stable
security definer
set search_path to ''
as $$
  select s.decrypted_secret
  from vault.decrypted_secrets s
  where s.name = public.model_key_secret_name(p_organization_id);
$$;

revoke execute on function public.get_model_api_key(uuid)
from public, anon, authenticated;

grant execute on function public.get_model_api_key(uuid) to service_role;

-- Gravar é da tela, então esta aceita `authenticated` — e confere admin por
-- dentro, porque `security definer` roda com os poderes do dono da função.
create function public.set_model_api_key(
  p_organization_id uuid,
  p_key text
)
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
  _name text := public.model_key_secret_name(p_organization_id);
  _id uuid;
begin
  if p_organization_id not in (select public.get_authorized_orgs('admin')) then
    raise exception 'not authorized to set the model key'
      using errcode = 'insufficient_privilege';
  end if;

  -- Vazio apaga. É o único jeito de a pessoa voltar a usar o crédito da
  -- plataforma depois de ter posto a chave dela, e sem isso a decisão seria de
  -- mão única.
  if nullif(p_key, '') is null then
    delete from vault.secrets where name = _name;
    return;
  end if;

  select id into _id from vault.secrets where name = _name;

  if _id is null then
    perform vault.create_secret(
      p_key,
      _name,
      'Model provider API key for organization ' || p_organization_id::text
    );
  else
    perform vault.update_secret(_id, p_key);
  end if;
end;
$$;

revoke execute on function public.set_model_api_key(uuid, text) from public, anon;
grant execute on function public.set_model_api_key(uuid, text) to authenticated;
