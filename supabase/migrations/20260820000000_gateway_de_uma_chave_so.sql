-- # Nem todo gateway tem duas chaves
--
-- A tabela nasceu com `chave_publica` obrigatória porque o primeiro gateway
-- ligado — a AmploPay — usa duas, uma em cada cabeçalho. Isso virou uma regra
-- do banco a partir de um caso.
--
-- Mercado Pago e Asaas usam UMA: um token de acesso, uma chave de API. Com a
-- coluna obrigatória, quem os cadastrasse teria de inventar o que pôr no campo
-- que sobra — e um valor inventado numa coluna de credencial é pior que um
-- nulo, porque parece dado.
--
-- `salvar_gateway` também exigia as duas. Agora exige o segredo, que é o que
-- todo gateway tem, e aceita a pública vazia. - 2026/08/20

alter table public.gateway_credenciais
  alter column chave_publica drop not null;

comment on column public.gateway_credenciais.chave_publica is
  'A chave não secreta, quando o gateway tem uma. Nulo em quem usa só um token.';

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

  -- Só o segredo é exigido: é o único campo que todo gateway tem.
  if coalesce(trim(_secreta), '') = '' then
    raise exception 'a chave secreta é obrigatória';
  end if;

  insert into public.gateway_credenciais as g (
    organization_id, provedor, chave_publica, chave_secreta, segredo_webhook
  )
  values (
    _org,
    _provedor,
    nullif(trim(coalesce(_publica, '')), ''),
    trim(_secreta),
    nullif(trim(_webhook), '')
  )
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
