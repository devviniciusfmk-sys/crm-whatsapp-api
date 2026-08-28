-- Trial de 7 dias: coluna nova em billing.subscriptions, marcada na criação
-- da assinatura (billing.initialize_subscription) e limpa ao sair do plano
-- padrão (billing.change_plan). Sem trava de uso ainda — só o dado, pra
-- a UI mostrar dias restantes.

alter table billing.subscriptions
add column trial_ends_at timestamp with time zone;

create or replace function billing.initialize_subscription() returns trigger
language plpgsql
security definer
set search_path to ''
as $$
declare
  _tier_id text;
  _plan_id text;
begin
  select t.id into _tier_id
  from billing.tiers t
  where t.active = true
  order by t.level asc
  limit 1;

  if not found then
    raise warning 'billing: a loja % nasceu sem assinatura porque o catálogo não tem faixa ativa', new.id;
    return new;
  end if;

  insert into billing.subscriptions (organization_id, tier_id, trial_ends_at)
  values (new.id, _tier_id, now() + interval '7 days');

  select p.id into _plan_id
  from billing.plans p
  where p.is_default = true
    and p.active = true
  limit 1;

  if _plan_id is not null then
    perform billing.change_plan(new.id, _plan_id);
  end if;

  return new;
end;
$$;

create or replace function billing.change_plan(
  _organization_id uuid,
  _plan_id text
) returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
  _plan billing.plans%rowtype;
  _tier_id text;
  _pp record;
begin
  select * into strict _plan
  from billing.plans p
  where p.id = _plan_id
    and p.active = true;

  select t.id into _tier_id
  from billing.tiers t
  where t.level >= _plan.min_tier
    and t.active = true
  order by t.level asc
  limit 1;

  if _tier_id is null then
    raise exception 'No active tier found for plan %', _plan_id;
  end if;

  update billing.subscriptions
  set tier_id = _tier_id,
      plan_id = _plan_id,
      current_period_start = now(),
      trial_ends_at = case when _plan.is_default then trial_ends_at else null end
  where organization_id = _organization_id;

  for _pp in
    select pp.product_id, pp.included
    from billing.plans_products pp
    join billing.products p on p.id = pp.product_id
    where pp.plan_id = _plan_id
      and p.kind = 'balance'
      and pp.included is not null
      and pp.included > 0
  loop
    insert into billing.ledger (organization_id, product_id, type, quantity)
    values (_organization_id, _pp.product_id, 'grant', _pp.included);
  end loop;
end;
$$;

-- A "Converte AI" já existe (fora deste gatilho) e ainda está dentro dos
-- 7 dias contados a partir de agora — sem isso ficaria sem trial_ends_at
-- pra sempre, já que o gatilho só roda em organizations recém-criadas.
update billing.subscriptions
set trial_ends_at = now() + interval '7 days'
where organization_id = '14ffd2f7-ebc3-4208-a0ab-c8e8b71a3f6f'
  and plan_id = 'free';
