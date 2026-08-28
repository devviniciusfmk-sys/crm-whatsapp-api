-- Chave da plataforma (OPENROUTER_API_KEY) passou a cobrar de verdade dos
-- créditos de IA a partir de 2026/08/27 — antes disso o crédito do free
-- nunca era gasto de fato. Com gasto real, US$0,50 por cadastro vitalício
-- vira um teto de caixa alto demais pros primeiros clientes: 20 cadastros já
-- estourariam US$10. Baixado pra US$0,10 — ainda dá dezenas de atendimentos
-- reais de IA, e o pior caso agora é 100 cadastros pra gastar os mesmos
-- US$10.
update billing.plans_products
set included = 0.10
where plan_id = 'free'
  and product_id = 'ai_credits';

-- "Atendimentos" (conversas) nunca teve teto no free — always ilimitado.
-- 50 por organização, vitalício (não mensal, como ai_credits): é cota de
-- trial pra conter o caixa dos primeiros clientes, não um limite recorrente
-- que se renova pra sempre em quem nunca assina. Bate com a mesma faixa de
-- uso do crédito de IA reduzido (uma conversa inteira custa ~US$0,001-0,003
-- de IA, então os dois tetos tendem a bater perto um do outro, em vez de um
-- surpreender antes do outro).
insert into billing.tiers_products (tier_id, product_id, cap, interval)
values ('free', 'conversations', 50, 'lifetime')
on conflict (tier_id, product_id) do update
set cap = excluded.cap, interval = excluded.interval;
