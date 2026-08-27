-- Escrita à mão, mesmo motivo das anteriores: o `supabase db diff` deste
-- projeto vem misturado com drift não relacionada. Só os objetos novos —
-- nenhum drop.

alter table "public"."negocios"
  add column "estado_normalizado" text,
  add column "cidade_normalizada" text,
  add column "origem_localizacao" text
    check (origem_localizacao in ('extraido_endereco', 'desconhecido'));

create or replace function public.sincronizar_negocios_externos(p_linhas jsonb)
returns int
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
      dores_identificadas jsonb,
      estado_normalizado text,
      cidade_normalizada text,
      origem_localizacao text
    )
  )
  insert into public.negocios (
    organization_id, externo_id, origem, nome, telefone, cidade, categoria,
    nicho, score_ia, veredito_ia, motivo_ia, abertura_sugerida, dores_identificadas,
    estado_normalizado, cidade_normalizada, origem_localizacao
  )
  select
    organization_id, externo_id, origem, nome, telefone, cidade, categoria,
    nicho, score_ia, veredito_ia, motivo_ia, abertura_sugerida, dores_identificadas,
    estado_normalizado, cidade_normalizada, origem_localizacao
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
