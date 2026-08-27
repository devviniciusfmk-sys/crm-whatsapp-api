-- Escrita à mão, mesmo motivo das anteriores: drift no `supabase db diff`
-- entre schemas e histórico já aplicado.

alter table "public"."negocios" drop constraint if exists "negocios_estagio_check";

alter table "public"."negocios"
  add constraint "negocios_estagio_check"
  check (estagio in ('descoberto','novo','contatado','qualificado','proposta','fechado','perdido'));

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
    estado_normalizado, cidade_normalizada, origem_localizacao, estagio
  )
  select
    organization_id, externo_id, origem, nome, telefone, cidade, categoria,
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

-- Backfill: só os negócios ainda intocados (estagio = 'novo', vindos da
-- sincronização automática) voltam pra 'descoberto'. Qualquer negócio já
-- movido de estágio, ou marcado manualmente durante os testes desta
-- sessão, fica exatamente onde está — o where restringe a 'novo' e a
-- origem sincronizada, nada mais.
update public.negocios
set estagio = 'descoberto'
where estagio = 'novo' and origem = 'leads_externos';
