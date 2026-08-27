-- Escrita à mão, mesmo motivo das anteriores: drift no `supabase db diff`
-- entre schemas e histórico já aplicado.
--
-- Corrige 20260827050000: `get_authorized_orgs` devolve `setof uuid`, um
-- valor escalar por linha sem nome de coluna — `select organization_id
-- from ...` falhava com "column organization_id does not exist" (achado
-- testando de verdade, via HTTP, com uma chave de API real).

create or replace function public.importar_negocios_do_cliente(p_linhas jsonb)
returns int
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_organization_id uuid;
  _linhas_afetadas int;
begin
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
