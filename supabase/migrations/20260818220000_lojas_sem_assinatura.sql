-- As lojas que nasceram antes do catálogo.
--
-- `billing.initialize_subscription` cria a assinatura no INSERT da loja: procura
-- a faixa ativa mais baixa e, se não achar nenhuma, sai calado. As três lojas
-- desta base foram cadastradas em 28/07 e 05/08; o catálogo só foi semeado em
-- 06/08. Todas passaram pelo gatilho num dia em que não havia faixa alguma para
-- achar, e ele fez exatamente o que estava escrito: nada, sem reclamar.
--
-- O medidor, esse, sempre rodou — há uso e lançamentos gravados desde então.
-- Falta só a linha que liga a loja ao plano, sem a qual as telas de cotas e uso
-- não têm limite de onde ler e aparecem vazias.
--
-- Duas partes: o gatilho passa a avisar no log quando desiste, e as lojas que
-- ficaram do lado errado da data recebem agora o que ele teria dado a elas.

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

  -- Create subscription with tier only
  insert into billing.subscriptions (organization_id, tier_id)
  values (new.id, _tier_id);

  -- Assign default plan if one exists
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

-- O mesmo que o gatilho faria, para quem passou por ele cedo demais.
do $$
declare
  _tier_id text;
  _plan_id text;
  _loja record;
  _quantas int := 0;
begin
  select t.id into _tier_id
  from billing.tiers t
  where t.active = true
  order by t.level asc
  limit 1;

  if not found then
    raise warning 'billing: catálogo ainda sem faixa ativa, nada a recuperar';
    return;
  end if;

  select p.id into _plan_id
  from billing.plans p
  where p.is_default = true
    and p.active = true
  limit 1;

  for _loja in
    select o.id, o.name
    from public.organizations o
    where not exists (
      select 1 from billing.subscriptions s where s.organization_id = o.id
    )
  loop
    insert into billing.subscriptions (organization_id, tier_id)
    values (_loja.id, _tier_id);

    if _plan_id is not null then
      perform billing.change_plan(_loja.id, _plan_id);
    end if;

    _quantas := _quantas + 1;

    raise notice 'billing: % entrou na faixa % / plano %',
      _loja.name, _tier_id, coalesce(_plan_id, '(nenhum)');
  end loop;

  raise notice 'billing: % loja(s) recuperada(s)', _quantas;
end $$;
