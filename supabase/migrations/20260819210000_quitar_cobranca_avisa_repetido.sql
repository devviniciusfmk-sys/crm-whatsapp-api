-- Quitar duas vezes devolve NADA na segunda.
--
-- A função já era idempotente para o banco: a segunda chamada não recalculava
-- o vencimento. Mas devolvia a linha do mesmo jeito, e quem chama não tinha
-- como saber que não fez nada — então o webhook mandava a confirmação de novo,
-- e o cliente recebia "pagamento confirmado" duas vezes pela mesma compra.
--
-- Medido em 2026/08/19 pelo `npm run test:webhook`, que existe para isto: todo
-- gateway reenvia quando não recebe 200 rápido o bastante.
--
-- Nulo é a resposta certa para "não fiz nada": quem chama decide o que fazer
-- com isso, e o silêncio é sempre a decisão segura quando se fala com cliente.
create or replace function public.quitar_cobranca(
  _cobranca uuid,
  _metodo text default null,
  _external_id text default null
) returns public.cobrancas
language plpgsql
security definer
set search_path to ''
as $$
declare
  _c public.cobrancas%rowtype;
begin
  -- `strict` de propósito: cobrança que não existe é erro de quem chamou, e
  -- merece estourar. Já paga é o caso normal do reenvio, e devolve nulo.
  select * into strict _c from public.cobrancas where id = _cobranca;

  if _c.status = 'paga' then
    return null;
  end if;

  update public.cobrancas
  set status = 'paga',
      paga_em = now(),
      vence_em = public.vencimento_da_cobranca(_cobranca, now()),
      metodo = coalesce(_metodo, metodo),
      external_id = coalesce(_external_id, external_id)
  where id = _cobranca
  returning * into _c;

  return _c;
end;
$$;
