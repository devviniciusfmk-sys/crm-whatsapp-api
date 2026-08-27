/**
 * Sincroniza um lote de negócios vindos da base externa de leads.
 *
 * Upsert por `(organization_id, origem, externo_id)` — a mesma sincronização
 * rodando de novo atualiza os campos vindos da IA (nome, telefone, score,
 * dores, abertura sugerida) sem duplicar a linha. `estagio`, `valor_estimado`
 * e `conversation_id` ficam DE FORA do `do update set` de propósito: são
 * campos que um humano mexe depois que o negócio chega — sincronizar de novo
 * não pode devolver um negócio "qualificado" para "novo" só porque a IA
 * rodou outra vez sobre o mesmo lead.
 *
 * Recebe o lote inteiro como jsonb (um array de objetos) e faz um insert só,
 * em vez de uma chamada por linha — a base externa tem mais de mil leads, e
 * uma função de borda não devia abrir milhares de round-trips ao Postgres
 * para uma rotina que roda sozinha a cada 30 minutos.
 */
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

revoke execute on function public.sincronizar_negocios_externos(jsonb)
from public, anon, authenticated;

grant execute on function public.sincronizar_negocios_externos(jsonb)
to service_role;
