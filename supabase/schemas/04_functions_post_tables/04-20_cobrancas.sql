-- Quitar uma cobrança, e a regra do vencimento num lugar só.
--
-- A conta do "até quando vale" vivia no TypeScript da tela. Com o gateway
-- avisando por webhook, o servidor precisaria da mesma conta — e duas
-- implementações da mesma regra é como uma delas dá 18/09 e a outra 23/09 para
-- o mesmo cliente. Desce para o banco, que é onde as duas pontas chegam.

/**
 * Até quando vale o que está sendo pago nesta cobrança.
 *
 * Conta do PAGAMENTO e não do envio: o plano começa a valer quando o dinheiro
 * entra, e entre a cobrança e o pagamento pode passar uma semana.
 *
 * E quando o cliente RENOVA antes de vencer, conta do vencimento que ele já
 * tem. Quem paga faltando cinco dias perderia esses cinco, que já comprou.
 *
 * A própria cobrança fica FORA da busca do que ainda vale — senão, ao ser
 * quitada, ela se veria e somaria em cima de si mesma.
 */
create or replace function public.vencimento_da_cobranca(
  _cobranca uuid,
  _quando timestamptz default now()
) returns timestamptz
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
  _c public.cobrancas%rowtype;
  _comeca timestamptz;
begin
  select * into _c from public.cobrancas where id = _cobranca;

  if not found or _c.validade_dias is null then
    return null;
  end if;

  select max(o.vence_em) into _comeca
  from public.cobrancas o
  where o.contact_address = _c.contact_address
    and o.organization_id = _c.organization_id
    and o.status = 'paga'
    and o.id <> _c.id
    and o.vence_em > _quando;

  return coalesce(_comeca, _quando) + (_c.validade_dias || ' days')::interval;
end;
$$;

/**
 * Marca a cobrança como paga e devolve a linha — ou NADA, se já estava paga.
 *
 * Devolver nulo na segunda chamada é o que impede o cliente de receber duas
 * confirmações pela mesma compra: todo gateway reenvia o postback quando não
 * recebe 200 rápido o bastante, e quem chama precisa saber que não fez nada.
 */
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

grant execute on function public.vencimento_da_cobranca(uuid, timestamptz)
to anon, authenticated, service_role;

grant execute on function public.quitar_cobranca(uuid, text, text)
to anon, authenticated, service_role;
