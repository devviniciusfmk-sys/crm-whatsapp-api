-- A chave do provedor de modelo sai do jsonb e vai para o cofre.
--
-- `agents.extra.api_key` é uma coluna jsonb, e a política "members can read
-- their orgs agents" deixa qualquer atendente da organização lê-la. Quem foi
-- contratado para responder mensagens tinha acesso ao crédito de IA da conta.
--
-- É exatamente a armadilha que o token da Meta já tinha, e que o comentário de
-- `whatsapp_token_secret_name` descreve: coluna jsonb é lida por toda a
-- organização e vai verbatim para webhooks de cliente.
--
-- Por organização, e não por agente: a chave é da conta, não do comportamento.
-- E apagar um agente levava a chave junto — aconteceu aqui, e o assistente
-- seguinte nasceu sem com que rodar.
--
-- O comentário completo está em schemas/02_functions/02-05_vault_secrets.sql.
-- Escrita à mão a partir do `db diff`, como as anteriores: o diff continua
-- propondo os 180 `revoke` sobre todas as tabelas, que derrubariam o produto.
-- - 2026/08/05

set check_function_bodies = off;

create or replace function public.model_key_secret_name(p_organization_id uuid)
returns text
language sql
immutable
set search_path to ''
as $function$
  select 'model_key:' || p_organization_id::text;
$function$;

revoke execute on function public.model_key_secret_name(uuid)
from public, anon, authenticated;

create or replace function public.get_model_api_key(p_organization_id uuid)
returns text
language sql
stable
security definer
set search_path to ''
as $function$
  select s.decrypted_secret
  from vault.decrypted_secrets s
  where s.name = public.model_key_secret_name(p_organization_id);
$function$;

revoke execute on function public.get_model_api_key(uuid)
from public, anon, authenticated;

grant execute on function public.get_model_api_key(uuid) to service_role;

create or replace function public.set_model_api_key(
  p_organization_id uuid,
  p_key text
)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
declare
  _name text := public.model_key_secret_name(p_organization_id);
  _id uuid;
begin
  if p_organization_id not in (select public.get_authorized_orgs('admin')) then
    raise exception 'not authorized to set the model key'
      using errcode = 'insufficient_privilege';
  end if;

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
$function$;

revoke execute on function public.set_model_api_key(uuid, text) from public, anon;
grant execute on function public.set_model_api_key(uuid, text) to authenticated;

create or replace function public.has_model_api_key(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path to ''
as $function$
  select
    p_organization_id in (select public.get_authorized_orgs('member'))
    and exists (
      select 1 from vault.secrets
      where name = public.model_key_secret_name(p_organization_id)
    );
$function$;

revoke execute on function public.has_model_api_key(uuid) from public, anon;
grant execute on function public.has_model_api_key(uuid) to authenticated;

-- Move o que já existe, e limpa o rastro.
--
-- Uma chave por organização: se houver mais de um agente com chave diferente na
-- mesma organização, a do agente mais antigo vence — e as outras continuam no
-- campo antigo, que o backend ainda lê como segunda opção. Ninguém fica sem
-- assistente por causa desta migração.
--
-- O `update` no fim é o que fecha o buraco de verdade: enquanto a chave estiver
-- no jsonb, ela continua legível por qualquer atendente, esteja ou não também
-- no cofre.
do $$
declare
  _org record;
begin
  for _org in
    select distinct on (organization_id)
      organization_id,
      extra ->> 'api_key' as key
    from public.agents
    where nullif(extra ->> 'api_key', '') is not null
    order by organization_id, created_at asc
  loop
    if not exists (
      select 1 from vault.secrets
      where name = public.model_key_secret_name(_org.organization_id)
    ) then
      perform vault.create_secret(
        _org.key,
        public.model_key_secret_name(_org.organization_id),
        'Model provider API key for organization ' || _org.organization_id::text
      );
    end if;
  end loop;
end $$;

-- O gatilho de merge precisa sair do caminho.
--
-- `agents` tem `set_extra before update ... merge_update('extra')`, e o merge
-- une o antigo com o novo — então `extra - 'api_key'` era desfeito na hora:
-- testado, e as chaves continuavam lá depois do update. A migração teria
-- "funcionado" deixando todas as chaves à vista, que é exatamente o defeito que
-- ela existe para fechar.
--
-- Desligar o gatilho é seguro aqui: roda uma vez, numa tabela pequena, e volta
-- ligado na linha seguinte.
alter table public.agents disable trigger set_extra;

update public.agents
set extra = extra - 'api_key'
where nullif(extra ->> 'api_key', '') is not null;

alter table public.agents enable trigger set_extra;
