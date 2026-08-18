-- Quem já está acima do teto não pode ganhar assinatura.
--
-- A migração anterior deu assinatura às lojas que nasceram antes do catálogo.
-- Faltou olhar o que elas já tinham consumido — e `billing.check_limit` começa
-- pela porta que eu não li:
--
--   -- No subscription = no billing = allow
--   if not found then return true; end if;
--
-- Sem assinatura, tudo passa. Ao criar a linha eu liguei a cobrança numa loja
-- viva que este mês já usou 9.081 mensagens contra o teto de 1.000 do plano
-- grátis, e cujo saldo de crédito de IA está em -5,55 contra um piso de 0. A
-- próxima mensagem recebida seria recusada com "Usage limit reached", e o
-- assistente pararia de responder — os dois em produção, sem ninguém pedir.
--
-- Nenhuma das duas apareceu porque nenhuma mensagem chegou nos dez minutos
-- entre uma migração e outra. Foi sorte, não margem.
--
-- A regra que faltava: ligar a cobrança em quem já estourou é anunciar o limite
-- desligando o produto. Quem está por cima do teto fica sem assinatura — como
-- estava —, até que alguém escolha a faixa certa ou acerte o saldo. As lojas
-- dentro do teto ficam com a sua, e as telas de cotas e uso seguem funcionando
-- para elas.

do $$
declare
  _assinatura record;
  _estourou boolean;
  _quantas int := 0;
begin
  for _assinatura in
    select s.organization_id, s.tier_id, o.name
    from billing.subscriptions s
    join public.organizations o on o.id = s.organization_id
  loop
    -- Estourou se ALGUM produto com teto já está do lado errado dele. Contador
    -- e medidor têm teto por cima; saldo tem piso por baixo, e só conta como
    -- estouro quando já está abaixo — saldo igual ao piso é uma loja sem
    -- crédito, que é um estado normal do plano grátis e não um impedimento.
    select exists (
      select 1
      from billing.tiers_products tp
      join billing.products p on p.id = tp.product_id
      left join billing.usage u
        on u.organization_id = _assinatura.organization_id
       and u.product_id = tp.product_id
       and u.interval = tp.interval
       and u.period = case tp.interval
         when 'month' then date_trunc('month', current_date)::date
         when 'day' then current_date
         else '1970-01-01'::date
       end
      where tp.tier_id = _assinatura.tier_id
        and tp.cap is not null
        and case
          when p.kind = 'balance' then coalesce(u.quantity, 0) < tp.cap
          else coalesce(u.quantity, 0) > tp.cap
        end
    ) into _estourou;

    if _estourou then
      delete from billing.subscriptions
      where organization_id = _assinatura.organization_id;

      _quantas := _quantas + 1;

      raise notice 'billing: % sai da cobrança — já estava acima do teto da faixa %',
        _assinatura.name, _assinatura.tier_id;
    end if;
  end loop;

  raise notice 'billing: % loja(s) devolvida(s) ao estado anterior', _quantas;
end $$;
