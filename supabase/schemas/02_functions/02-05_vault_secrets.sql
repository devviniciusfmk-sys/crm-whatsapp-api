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
--
-- `language plpgsql`, e não `sql`: uma função `sql` é validada contra o
-- catálogo NA CRIAÇÃO, e `get_authorized_orgs` só existe a partir de
-- `04_functions_post_tables`, lida depois desta pasta — `language sql`
-- aqui quebrava `supabase db diff` com "function get_authorized_orgs does
-- not exist". `plpgsql` adia essa checagem para a EXECUÇÃO, que é quando
-- a função já existe de verdade. Achado ao gerar a migração da loja de
-- números em 2026/08/26, sem relação com ela. - 2026/08/26
create function public.has_voz_api_key(p_organization_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path to ''
as $$
begin
  return exists (
    select 1 from vault.secrets
    where name = public.voz_key_secret_name(p_organization_id)
      and p_organization_id in (select public.get_authorized_orgs('member'))
  );
end;
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
--
-- `language plpgsql`: mesmo motivo de `has_voz_api_key` acima — esta
-- também referencia `public.iptv_servidores` (de `03_models`) e
-- `get_authorized_orgs` (de `04_functions_post_tables`), as duas lidas
-- depois desta pasta. `language sql` validava contra o catálogo na
-- criação e quebrava `supabase db diff` duas vezes seguidas.
create function public.has_iptv_token(p_servidor_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path to ''
as $$
begin
  return exists (
    select 1
    from vault.secrets v
    join public.iptv_servidores s on s.id = p_servidor_id
    where v.name = public.iptv_token_secret_name(p_servidor_id)
      and s.organization_id in (select public.get_authorized_orgs('member'))
  );
end;
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

-- O gatilho que liga esta função a `public.iptv_servidores` mora em
-- `04_functions_post_tables/04-10_vault_secrets_triggers.sql`, não aqui:
-- a tabela só existe a partir de `03_models`, lida depois desta pasta.
-- - 2026/08/26

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

-- O gatilho que liga esta função a `public.loja_numeros` também mora em
-- `04_functions_post_tables/04-10_vault_secrets_triggers.sql`, pelo mesmo
-- motivo do de cima.

-- ## A credencial da base externa de leads
--
-- Não é segredo de organização — é da PLATAFORMA, como `edge_functions_url`/
-- `edge_functions_token`: um só par de valores, semeado uma vez à mão
-- (`vault.create_secret`), sem função `set_*` e sem tela nenhuma escrevendo
-- por cima. Só a função de borda `leads-sync` lê, por isso `service_role`
-- é o único grant — mesmo trato de `get_loja_numero_token`.
create function public.get_leads_externos_config()
returns table(url text, secret_key text)
language sql
stable
security definer
set search_path to ''
as $$
  select
    (select decrypted_secret from vault.decrypted_secrets where name = 'leads_externos_url'),
    (select decrypted_secret from vault.decrypted_secrets where name = 'leads_externos_secret_key');
$$;

revoke execute on function public.get_leads_externos_config()
from public, anon, authenticated;

grant execute on function public.get_leads_externos_config() to service_role;

-- ## Semear um segredo de plataforma, genérico
--
-- `edge_functions_url`/`edge_functions_token` (lidos por `02-02_edge_functions.sql`
-- e por todo cron que chama uma função de borda) nunca tiveram um jeito de
-- serem gravados fora de `psql` direto contra o banco — o script de CI
-- (`deploy-vault-secrets.sh`) supõe acesso à senha do Postgres, que nem
-- sempre existe (não existe neste projeto). Esta função cobre os dois: eles
-- e `leads_externos_url`/`leads_externos_secret_key`, sem precisar de senha
-- de banco — só a chave de serviço, que já é confiança total mesmo.
--
-- Não é keyada por linha nenhuma (não há `<algo>_secret_name` correspondente)
-- porque não é um segredo por organização/servidor/número — é uma lista
-- fechada de nomes de plataforma, e nenhum outro tipo de segredo se
-- beneficiaria de passar por aqui.
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
