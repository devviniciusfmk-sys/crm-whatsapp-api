-- A máquina de cobrar: fatura, pagamento, e a ponte para os gateways.
--
-- As tabelas já existiam inteiras — `invoices` com estados, `invoices_items`
-- com preço unitário, `payments` com `external_id`, que é exatamente onde a
-- transação de um gateway se ancora. Faltava quem as movesse: nenhuma fatura
-- foi emitida desde que subiram, e `billing.accounts` está vazia.
--
-- Três peças, e nenhuma delas depende de gateway nenhum:
--
--   1. a conta que liga a loja a quem paga (e ao identificador no gateway)
--   2. emitir a fatura do mês
--   3. registrar o pagamento e quitar
--
-- O Pix manual usa as três e mais nada. AmploPay, Kirvano e Kiwify entram
-- depois pelo mesmo `registrar_pagamento`, cada um com um adaptador que só
-- traduz o formato do postback — o miolo é este aqui, e é comum aos três.

-- 1. A conta -----------------------------------------------------------------
-- `accounts` nasceu com id e nome, o que descreve um cliente e não diz como
-- reconhecê-lo quando um postback chega. O gateway manda um identificador seu
-- e um e-mail; sem guardar os dois, o webhook recebe um pagamento e não sabe
-- de quem é.

alter table billing.accounts
add column if not exists organization_id uuid
references public.organizations(id) on delete cascade;

alter table billing.accounts
add column if not exists email text;

alter table billing.accounts
add column if not exists provider text;

alter table billing.accounts
add column if not exists external_id text;

comment on column billing.accounts.provider is
  'pix | amplopay | kirvano | kiwify — de onde vem o dinheiro desta conta';

comment on column billing.accounts.external_id is
  'O id do cliente no gateway. É por ele que o postback acha a loja.';

-- Um mesmo cliente não pode existir duas vezes no mesmo gateway: sem isto, um
-- reenvio de postback cria uma segunda conta e o pagamento seguinte cai na
-- errada.
create unique index if not exists accounts_provider_external_idx
on billing.accounts (provider, external_id)
where provider is not null and external_id is not null;

create index if not exists accounts_organization_id_idx
on billing.accounts (organization_id);

-- O mesmo para o pagamento: um postback reenviado é o caso comum, não o raro.
-- Todo gateway reenvia quando não recebe 200 rápido o bastante, e sem esta
-- restrição o segundo envio vira um segundo pagamento e a fatura fica paga
-- duas vezes.
create unique index if not exists payments_external_id_idx
on billing.payments (method, external_id)
where external_id is not null;

-- 2. Emitir a fatura ---------------------------------------------------------

create or replace function billing.emitir_fatura(
  _organization_id uuid,
  _quando date default current_date
) returns uuid
language plpgsql
security definer
set search_path to ''
as $$
declare
  _plano billing.plans%rowtype;
  _inicio timestamptz := date_trunc('month', _quando)::timestamptz;
  _fim timestamptz := (date_trunc('month', _quando) + interval '1 month')::timestamptz;
  _fatura uuid;
begin
  select p.* into _plano
  from billing.subscriptions s
  join billing.plans p on p.id = s.plan_id
  where s.organization_id = _organization_id;

  -- Sem plano, ou plano de graça: não há o que cobrar, e emitir fatura de zero
  -- é dar trabalho a quem for conferir.
  if not found or coalesce(_plano.price, 0) <= 0 then
    return null;
  end if;

  -- Já emitida: a função roda por cron e por mão, e o mês tem uma fatura só.
  select i.id into _fatura
  from billing.invoices i
  where i.organization_id = _organization_id
    and i.period_start = _inicio
    and i.status <> 'void';

  if found then
    return _fatura;
  end if;

  insert into billing.invoices (
    organization_id, period_start, period_end, status, subtotal
  )
  values (_organization_id, _inicio, _fim, 'issued', _plano.price)
  returning id into _fatura;

  insert into billing.invoices_items (
    invoice_id, type, plan_id, quantity, unit_price, amount
  )
  values (_fatura, 'plan', _plano.id, 1, _plano.price, _plano.price);

  return _fatura;
end;
$$;

create or replace function billing.emitir_faturas_do_mes(
  _quando date default current_date
) returns int
language plpgsql
security definer
set search_path to ''
as $$
declare
  _loja record;
  _quantas int := 0;
begin
  for _loja in
    select s.organization_id
    from billing.subscriptions s
    join billing.plans p on p.id = s.plan_id
    where coalesce(p.price, 0) > 0
  loop
    if billing.emitir_fatura(_loja.organization_id, _quando) is not null then
      _quantas := _quantas + 1;
    end if;
  end loop;

  return _quantas;
end;
$$;

-- 3. Registrar o pagamento ---------------------------------------------------

create or replace function billing.registrar_pagamento(
  _invoice_id uuid,
  _amount numeric,
  _method text,
  _external_id text default null,
  _account_id uuid default null
) returns uuid
language plpgsql
security definer
set search_path to ''
as $$
declare
  _fatura billing.invoices%rowtype;
  _pago numeric;
  _pagamento uuid;
begin
  select * into strict _fatura
  from billing.invoices i
  where i.id = _invoice_id;

  -- Reenvio do mesmo postback: devolve o pagamento que já existe, em vez de
  -- criar o segundo. Sem isto o `unique` estouraria e o gateway leria o erro
  -- como "não recebido", reenviando para sempre.
  if _external_id is not null then
    select p.id into _pagamento
    from billing.payments p
    where p.method = _method
      and p.external_id = _external_id;

    if found then
      return _pagamento;
    end if;
  end if;

  insert into billing.payments (
    invoice_id, organization_id, account_id, amount, method, status, external_id
  )
  values (
    _invoice_id,
    _fatura.organization_id,
    _account_id,
    _amount,
    _method,
    'succeeded',
    _external_id
  )
  returning id into _pagamento;

  -- Quita quando o somado alcança o total, e não quando chega um pagamento:
  -- um Pix quebrado em dois é um caso real, e quitar no primeiro seria dar por
  -- paga uma fatura pela metade.
  select coalesce(sum(p.amount), 0) into _pago
  from billing.payments p
  where p.invoice_id = _invoice_id
    and p.status = 'succeeded';

  if _pago >= _fatura.subtotal then
    update billing.invoices
    set status = 'paid'
    where id = _invoice_id;
  end if;

  return _pagamento;
end;
$$;

-- O relógio ------------------------------------------------------------------
-- Todo dia 1, às 6 da manhã UTC (3 da manhã em Brasília). SQL puro, sem função
-- de borda: não há nada aqui que precise sair do banco.
select
  cron.schedule(
    'emitir-faturas-do-mes',
    '0 6 1 * *',
    $$select billing.emitir_faturas_do_mes();$$
  );
