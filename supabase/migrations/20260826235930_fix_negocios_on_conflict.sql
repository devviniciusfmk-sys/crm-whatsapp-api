-- Corrige `sincronizar_negocios_externos`: o índice único
-- (`negocios_externo_idx`) é parcial (`where externo_id is not null`), e o
-- `on conflict` original não repetia essa condição — Postgres não infere um
-- índice parcial sem o `where` correspondente na cláusula, e a primeira
-- tentativa real (testada manualmente após o deploy) devolveu 42P10 "there
-- is no unique or exclusion constraint matching the ON CONFLICT
-- specification".
create or replace function public.sincronizar_negocios_externos(p_linhas jsonb)
returns integer
language plpgsql
security definer
set search_path to ''
as $$
declare
  _linhas_afetadas int;
begin
  with dados as (
    select * from jsonb_to_recordset(p_linhas) as x(
      organization_id uuid,
      externo_id text,
      origem text,
      nome text,
      telefone text,
      cidade text,
      categoria text,
      nicho text,
      score_ia real,
      veredito_ia text,
      motivo_ia text,
      abertura_sugerida text,
      dores_identificadas jsonb
    )
  )
  insert into public.negocios (
    organization_id, externo_id, origem, nome, telefone, cidade, categoria,
    nicho, score_ia, veredito_ia, motivo_ia, abertura_sugerida, dores_identificadas
  )
  select
    organization_id, externo_id, origem, nome, telefone, cidade, categoria,
    nicho, score_ia, veredito_ia, motivo_ia, abertura_sugerida, dores_identificadas
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
    atualizado_em = now();

  get diagnostics _linhas_afetadas = row_count;

  return _linhas_afetadas;
end;
$$;
