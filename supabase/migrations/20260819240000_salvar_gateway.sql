-- # Gravar credencial sem poder ler credencial
--
-- A tabela guarda a chave secreta com o SELECT revogado, e isso funciona: nem
-- o dono da loja lê a coluna de volta. Só que o PostgREST precisa de SELECT na
-- tabela para INSERT e UPDATE — mesmo com `return=minimal` — e o cadastro
-- inteiro passava a ser recusado. As duas coisas não cabiam pela mesma porta.
--
-- Então a escrita sai da porta da tabela e passa por esta função. Ela roda como
-- dona do esquema, confere que quem chamou é admin da organização, e grava. O
-- resultado é o contrato que se queria desde o começo:
--
--   * escrever  → só por aqui, e só admin
--   * ler o segredo → só a chave de serviço, na função de borda
--   * ler o resto → qualquer membro, pelas colunas liberadas
--
-- `security definer` sem a checagem de admin seria uma porta aberta a qualquer
-- pessoa logada, em qualquer organização. A checagem É a função. - 2026/08/19

create or replace function public.salvar_gateway(
  _org uuid,
  _publica text,
  _secreta text,
  _webhook text default null,
  _provedor text default 'amplopay'
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if _org is null or _org not in (select public.get_authorized_orgs('admin')) then
    raise exception 'sem permissão para configurar o gateway desta organização';
  end if;

  if coalesce(trim(_publica), '') = '' or coalesce(trim(_secreta), '') = '' then
    raise exception 'chave pública e secreta são obrigatórias';
  end if;

  insert into public.gateway_credenciais as g (
    organization_id, provedor, chave_publica, chave_secreta, segredo_webhook
  )
  values (_org, _provedor, trim(_publica), trim(_secreta), nullif(trim(_webhook), ''))
  on conflict (organization_id) do update set
    provedor        = excluded.provedor,
    chave_publica   = excluded.chave_publica,
    chave_secreta   = excluded.chave_secreta,
    -- Só sobrescreve o token do postback quando um novo foi enviado: a tela
    -- que edita apenas as chaves não pode apagar o que já estava lá.
    segredo_webhook = coalesce(excluded.segredo_webhook, g.segredo_webhook),
    ativo           = true,
    atualizado_em   = now();
end;
$$;

comment on function public.salvar_gateway is
  'Grava as credenciais do gateway. Único caminho de escrita: a tabela não concede insert/update.';

-- A porta da tabela fecha. Sobra a leitura das colunas públicas, que a tela usa
-- para dizer "gateway configurado".
revoke insert, update, delete on public.gateway_credenciais from authenticated, anon;

grant execute on function public.salvar_gateway(uuid, text, text, text, text)
  to authenticated, anon;
