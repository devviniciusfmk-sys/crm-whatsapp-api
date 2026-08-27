/**
 * Porta pública de `negocios`, pra quem já tem os próprios leads e só
 * precisa empurrar pra dentro — sem ser o cron interno do scraping
 * (`sincronizar_negocios_externos`, 04-32), que continua existindo do
 * jeito que está, sem tocar.
 *
 * Reaproveita 100% a autenticação que já existe (`public.api_keys` +
 * `get_authorized_orgs`, o mesmo mecanismo que já autentica o servidor
 * MCP) — o que faltava não era autenticar, era uma função que confiasse
 * em QUEM ESTÁ AUTENTICADO, e não no que o payload diz.
 *
 * Duas coisas o payload NUNCA decide, mesmo que tente:
 *
 *   organization_id   sempre a organização da própria chave de API
 *                      (`get_authorized_orgs('member')`) — nunca o que
 *                      vier em cada linha. É a diferença entre "seguro
 *                      porque só o cron chama" (sincronizar_negocios_
 *                      externos) e "seguro pra abrir pra qualquer
 *                      organização" (esta função).
 *   origem             sempre 'api_cliente', pra sempre dar pra saber
 *                      num relatório se um negócio veio do scraping
 *                      interno ou da API pública de um cliente.
 *
 * Mesmo upsert de sincronizar_negocios_externos: `estagio` nasce
 * 'descoberto' (fora do Kanban até alguém promover na pesquisa de
 * leads), e `estagio`/`valor_estimado`/`conversation_id` ficam de fora
 * do `do update set` — reenviar o mesmo lote não pode devolver um
 * negócio já trabalhado pra trás. `externo_id` é obrigatório pra isso
 * funcionar: é a chave que evita duplicar a cada reenvio. - 2026/08/27
 */
create function public.importar_negocios_do_cliente(p_linhas jsonb)
returns int
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_organization_id uuid;
  _linhas_afetadas int;
begin
  -- `get_authorized_orgs` devolve `setof uuid` — um valor escalar por
  -- linha, sem nome de coluna. `select organization_id from ...` falha
  -- com "column organization_id does not exist"; a subconsulta escalar é
  -- o jeito certo de pegar o primeiro (e, numa chamada por api-key, único)
  -- valor.
  v_organization_id := (
    select * from public.get_authorized_orgs('member') limit 1
  );

  if v_organization_id is null then
    raise exception using
      errcode = '42501',
      message = 'Nenhuma organização autorizada para esta chave.';
  end if;

  with dados as (
    select * from jsonb_to_recordset(p_linhas) as x(
      externo_id text,
      nome text,
      telefone text,
      cidade text,
      categoria text,
      nicho text,
      score_ia real,
      veredito_ia text,
      motivo_ia text,
      abertura_sugerida text,
      dores_identificadas jsonb,
      estado_normalizado text,
      cidade_normalizada text,
      origem_localizacao text
    )
  )
  insert into public.negocios (
    organization_id, externo_id, origem, nome, telefone, cidade, categoria,
    nicho, score_ia, veredito_ia, motivo_ia, abertura_sugerida, dores_identificadas,
    estado_normalizado, cidade_normalizada, origem_localizacao, estagio
  )
  select
    v_organization_id, externo_id, 'api_cliente', nome, telefone, cidade, categoria,
    nicho, score_ia, veredito_ia, motivo_ia, abertura_sugerida, dores_identificadas,
    estado_normalizado, cidade_normalizada, origem_localizacao, 'descoberto'
  from dados
  on conflict (organization_id, origem, externo_id) where externo_id is not null do update set
    nome = excluded.nome,
    telefone = excluded.telefone,
    cidade = excluded.cidade,
    categoria = excluded.categoria,
    nicho = excluded.nicho,
    score_ia = excluded.score_ia,
    veredito_ia = excluded.veredito_ia,
    motivo_ia = excluded.motivo_ia,
    abertura_sugerida = excluded.abertura_sugerida,
    dores_identificadas = excluded.dores_identificadas,
    estado_normalizado = excluded.estado_normalizado,
    cidade_normalizada = excluded.cidade_normalizada,
    origem_localizacao = excluded.origem_localizacao,
    atualizado_em = now();

  get diagnostics _linhas_afetadas = row_count;

  return _linhas_afetadas;
end;
$$;

revoke execute on function public.importar_negocios_do_cliente(jsonb)
from public;

-- `anon`, e não só `authenticated`: quem chama com uma api-key (sem JWT de
-- usuário) autentica como `anon` pro PostgREST — é o mesmo par de papéis
-- que a policy de `negocios` já usa (05-32_negocios_rls.sql, `for all to
-- authenticated, anon`). A segurança de verdade não é o papel do
-- Postgres, é `get_authorized_orgs` dentro da função: sem uma api-key
-- válida no cabeçalho, ela nem chega a resolver `organization_id`.
grant execute on function public.importar_negocios_do_cliente(jsonb)
to authenticated, anon;
