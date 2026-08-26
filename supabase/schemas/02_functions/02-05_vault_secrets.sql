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

-- ## A chave da ElevenLabs, no mesmo trato da chave do modelo
--
-- Mesma forma, e de propósito: sem leitor para o navegador, gravada por
-- cima, apagada com vazio. Chave que a interface consegue ler é chave que
-- vaza pelo primeiro `console.log` de quem for depurar outra coisa.
--
-- É de CADA loja, e não uma do produto. Quem gasta paga: gerar áudio custa
-- por caractere, e uma chave compartilhada faria a fatura de uma loja que
-- abusa cair no colo de todas as outras. - 2026/08/22
create function public.voz_key_secret_name(p_organization_id uuid)
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
create function public.get_voz_api_key(p_organization_id uuid)
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
create function public.has_voz_api_key(p_organization_id uuid)
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

create function public.set_voz_api_key(
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

-- ## O token do painel de IPTV
--
-- A especificação que originou o módulo guardava o token numa coluna de
-- texto da própria tabela de servidores. Aqui isso é o erro que o token da
-- Meta já cometeu uma vez: a política de RLS deixa qualquer MEMBRO da
-- organização ler aquelas linhas, e o gatilho de webhook manda a linha
-- inteira para fora. Token nessas condições é público para a equipe.
--
-- Aqui ele é keyado pelo id do servidor, como o da Meta é pelo endereço.
-- - 2026/08/22
create function public.iptv_token_secret_name(p_servidor_id uuid)
returns text
language sql
immutable
set search_path to ''
as $$
  select 'iptv_token:' || p_servidor_id::text;
$$;

revoke execute on function public.iptv_token_secret_name(uuid)
from public, anon, authenticated;

-- Só o service_role: quem lê é a função de borda que fala com o painel.
create function public.get_iptv_token(p_servidor_id uuid)
returns text
language sql
stable
security definer
set search_path to ''
as $$
  select s.decrypted_secret
  from vault.decrypted_secrets s
  where s.name = public.iptv_token_secret_name(p_servidor_id);
$$;

revoke execute on function public.get_iptv_token(uuid)
from public, anon, authenticated;

grant execute on function public.get_iptv_token(uuid) to service_role;

-- A tela só pergunta se existe. Nunca o valor.
create function public.has_iptv_token(p_servidor_id uuid)
returns boolean
language sql
stable
security definer
set search_path to ''
as $$
  select exists (
    select 1
    from vault.secrets v
    join public.iptv_servidores s on s.id = p_servidor_id
    where v.name = public.iptv_token_secret_name(p_servidor_id)
      and s.organization_id in (select public.get_authorized_orgs('member'))
  );
$$;

revoke execute on function public.has_iptv_token(uuid) from public, anon;
grant execute on function public.has_iptv_token(uuid) to authenticated;

create function public.set_iptv_token(
  p_servidor_id uuid,
  p_token text
)
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
  _name text := public.iptv_token_secret_name(p_servidor_id);
  _org uuid;
  _id uuid;
begin
  select organization_id into _org
  from public.iptv_servidores where id = p_servidor_id;

  if _org is null
     or _org not in (select public.get_authorized_orgs('admin')) then
    raise exception 'not authorized to set the iptv token'
      using errcode = 'insufficient_privilege';
  end if;

  -- Vazio apaga: é como se desconecta um painel sem apagar o histórico de
  -- quem testou por ele.
  if nullif(p_token, '') is null then
    delete from vault.secrets where name = _name;
    return;
  end if;

  select id into _id from vault.secrets where name = _name;

  if _id is null then
    perform vault.create_secret(
      p_token,
      _name,
      'IPTV panel token for server ' || p_servidor_id::text
    );
  else
    perform vault.update_secret(_id, p_token);
  end if;
end;
$$;

revoke execute on function public.set_iptv_token(uuid, text) from public, anon;
grant execute on function public.set_iptv_token(uuid, text) to authenticated;

-- ## O token vai junto quando o servidor vai
--
-- Sem isto, apagar um painel deixa o segredo dele no cofre para sempre.
-- Ninguém consegue ler — `get_iptv_token` e `has_iptv_token` conferem o
-- servidor, que já não existe —, mas ele fica lá: um segredo que a tela
-- prometeu poder remover e que nenhuma tela alcança mais.
--
-- Medido na primeira prova do módulo, em 2026/08/22: apaguei o servidor e o
-- segredo continuou no cofre.
create function public.apagar_token_do_servidor()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
begin
  delete from vault.secrets
  where name = public.iptv_token_secret_name(old.id);

  return old;
end;
$$;

drop trigger if exists apagar_token on public.iptv_servidores;

create trigger apagar_token
after delete on public.iptv_servidores
for each row execute function public.apagar_token_do_servidor();

-- ## O token do número da loja
--
-- Cada número em `loja_numeros` já vem da Meta com um token de usuário do
-- sistema permanente — é o que deixa a plataforma mandar mensagem por ele
-- antes mesmo de existir uma organização dona. Mesmo trato do token da Meta
-- e do da IPTV: keyado pelo id da linha, nunca numa coluna de
-- `loja_numeros`, pela mesma razão de sempre — coluna é lida por RLS de quem
-- tiver acesso à linha e pode sair verbatim em alguma resposta.
create function public.loja_numero_token_secret_name(p_numero_id uuid)
returns text
language sql
immutable
set search_path to ''
as $$
  select 'loja_numero_token:' || p_numero_id::text;
$$;

revoke execute on function public.loja_numero_token_secret_name(uuid)
from public, anon, authenticated;

-- Só `service_role`, e mais estrito que `get_whatsapp_access_token`: aquele
-- confere `get_authorized_orgs` porque já existe uma organização dona do
-- endereço na hora da leitura. Aqui não — o número pode ainda estar
-- `disponivel` ou `reservado`, sem organização nenhuma, e é justamente nesse
-- momento (a plataforma testando/preparando o número antes da venda) que a
-- leitura precisa acontecer. Sem organização para checar, a única fronteira
-- possível é "isto só roda em código de confiança", que é o que `service_role`
-- já significa.
create function public.get_loja_numero_token(p_numero_id uuid)
returns text
language sql
stable
security definer
set search_path to ''
as $$
  select s.decrypted_secret
  from vault.decrypted_secrets s
  where s.name = public.loja_numero_token_secret_name(p_numero_id);
$$;

revoke execute on function public.get_loja_numero_token(uuid)
from public, anon, authenticated;

grant execute on function public.get_loja_numero_token(uuid) to service_role;

-- Só `service_role`, e não `authenticated` como `set_iptv_token`/
-- `set_model_api_key` — aquelas são chamadas direto pela tela de um admin
-- logado, e por isso se autoconferem com `get_authorized_orgs('admin')` por
-- dentro. Esta é chamada só pela função de borda `loja`, que já é
-- gate-keepada para admin da plataforma (não admin de organização) do lado
-- de fora, antes mesmo de chegar aqui — repetir a checagem de organização não
-- faria sentido para um token que ainda não tem organização dona.
create function public.set_loja_numero_token(
  p_numero_id uuid,
  p_token text
)
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
  _name text := public.loja_numero_token_secret_name(p_numero_id);
  _id uuid;
begin
  if nullif(p_token, '') is null then
    raise exception 'set_loja_numero_token: token must not be null or empty';
  end if;

  select id into _id from vault.secrets where name = _name;

  if _id is null then
    perform vault.create_secret(
      p_token,
      _name,
      'System user access token for loja number ' || p_numero_id::text
    );
  else
    perform vault.update_secret(_id, p_token);
  end if;
end;
$$;

revoke execute on function public.set_loja_numero_token(uuid, text)
from public, anon, authenticated;

grant execute on function public.set_loja_numero_token(uuid, text)
to service_role;

-- Sem isto, apagar um número da loja deixa o token dele no cofre para
-- sempre — mesmo caso de `apagar_token_do_servidor`, medido lá em
-- 2026/08/22 e nunca reaberto desde então.
create function public.apagar_token_do_numero_loja()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
begin
  delete from vault.secrets
  where name = public.loja_numero_token_secret_name(old.id);

  return old;
end;
$$;

drop trigger if exists apagar_token_numero_loja on public.loja_numeros;

create trigger apagar_token_numero_loja
after delete on public.loja_numeros
for each row execute function public.apagar_token_do_numero_loja();
