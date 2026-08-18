-- A loja viva entra no plano essencial.
--
-- Ela usa 9.081 mensagens por mês. No grátis (1.000) as mensagens seriam
-- recusadas; no essencial (25.000) sobra quase o triplo do que ela gasta. O pro
-- resolveria também, mas escolher um plano de R$ 197 para uma loja que cabe no
-- de R$ 97 é decidir por medo do teto, e não pelo tamanho dela.
--
-- Antes do plano, a dívida. O saldo de crédito de IA está em -5,547: consumo
-- real, gasto durante o beta, quando não havia assinatura e portanto ninguém
-- para cobrar. O piso é 0 em todas as faixas, então esse número sozinho já
-- pararia o assistente — e a concessão de 5 do essencial não cobre. Fica
-- perdoado com registro no razão, que é onde uma isenção precisa aparecer.
--
-- No fim, a migração pergunta ao próprio banco se a loja continua podendo
-- enviar e continuar respondendo. Se qualquer um dos dois recusar, ela estoura
-- e desfaz tudo: foi exatamente essa pergunta que faltou na primeira vez, e
-- sem ela uma migração de cobrança consegue desligar a loja em silêncio.

do $$
declare
  _org uuid;
  _nome text;
  _saldo numeric;
  _faixa text;
begin
  select o.id, o.name into _org, _nome
  from public.organizations o
  where o.name = 'Rakan SUP';

  if not found then
    raise notice 'billing: "Rakan SUP" não existe nesta base, nada a fazer';
    return;
  end if;

  -- 1. A dívida do beta ------------------------------------------------------
  -- O menor entre o do mês e o de sempre: o essencial cobra crédito por mês e
  -- o grátis por vida inteira, e deixar um dos dois negativo é deixar a conta
  -- armada para a próxima troca de plano.
  select least(
    coalesce((
      select u.quantity from billing.usage u
      where u.organization_id = _org
        and u.product_id = 'ai_credits'
        and u.interval = 'month'
        and u.period = date_trunc('month', current_date)::date
    ), 0),
    coalesce((
      select u.quantity from billing.usage u
      where u.organization_id = _org
        and u.product_id = 'ai_credits'
        and u.interval = 'lifetime'
    ), 0)
  ) into _saldo;

  if _saldo < 0 then
    insert into billing.ledger (organization_id, product_id, type, quantity, metadata)
    values (
      _org,
      'ai_credits',
      'grant',
      -_saldo,
      jsonb_build_object(
        'motivo', 'consumo de IA do beta, gasto antes de existir assinatura',
        'perdoado_em', current_date
      )
    );

    raise notice 'billing: perdoados % de crédito de IA gastos no beta', -_saldo;
  end if;

  -- 2. O plano ---------------------------------------------------------------
  if not exists (
    select 1 from billing.subscriptions s where s.organization_id = _org
  ) then
    select t.id into _faixa
    from billing.tiers t
    where t.active = true
    order by t.level asc
    limit 1;

    if _faixa is null then
      raise exception 'billing: catálogo sem faixa ativa';
    end if;

    insert into billing.subscriptions (organization_id, tier_id)
    values (_org, _faixa);
  end if;

  perform billing.change_plan(_org, 'essencial');

  -- 3. A pergunta que faltou -------------------------------------------------
  -- `check_limit` estoura quando recusa, e estourar aqui dentro desfaz tudo o
  -- que está acima. Uma loja viva sai desta migração funcionando, ou ela não
  -- acontece.
  perform billing.check_limit(_org, 'messages', 1);
  perform billing.check_limit(_org, 'ai_credits', 0.01);
  perform billing.check_limit(_org, 'storage', 0.001);

  raise notice 'billing: % entrou no essencial e continua podendo enviar', _nome;
end $$;
