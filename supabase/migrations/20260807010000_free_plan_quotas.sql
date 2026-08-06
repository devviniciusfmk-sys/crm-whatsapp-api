-- As cotas do plano gratuito, recalculadas com o custo medido.
--
-- Os números anteriores vieram de uma estimativa minha de 3.000 tokens de
-- entrada a US$ 0,037 por milhão — o preço anunciado do modelo. A fatura real
-- da primeira conversa foi **nove vezes maior**: a OpenRouter roteia entre
-- fornecedores e cobra o de quem atendeu, não o mais barato do catálogo.
--
-- Com o número verdadeiro (US$ 0,0009 por resposta, medido em 2026/08/06):
--
--   uma resposta       US$ 0,0009
--   um agendamento     ~8 respostas = US$ 0,0072
--   US$ 1,00           ~140 agendamentos
--
-- US$ 1 de crédito dá o mês inteiro de uma barbearia pequena. Isso não é
-- degustação, é o produto de graça — e quem opera de graça não assina.
--
-- ## O limite que vale é o que a pessoa entende
--
-- Crédito em dólar não diz nada para quem corta cabelo. "Mil mensagens por mês"
-- diz. Então a cota de mensagens é a que aperta primeiro, e o crédito fica
-- folgado de propósito: quem bater no teto vai bater no número que consegue
-- explicar para si mesmo, e não numa conta de tokens.
--
--   1.000 mensagens  ≈ 100 atendimentos, umas duas semanas de uso real
--   US$ 0,50         ≈ 550 respostas, bem mais do que 1.000 mensagens exigem
--
-- Os planos pagos não mudam: US$ 5 no Essencial ainda cobrem ~700 agendamentos
-- pelo custo real, contra 300–600 que uma barbearia movimentada faz.

update billing.tiers_products
set cap = 1000
where tier_id = 'free'
  and product_id = 'messages';

update billing.plans_products
set included = 1000
where plan_id = 'free'
  and product_id = 'messages';

update billing.plans_products
set included = 0.50
where plan_id = 'free'
  and product_id = 'ai_credits';
