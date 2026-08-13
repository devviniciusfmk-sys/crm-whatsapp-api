-- O crédito do assistente renova com a assinatura.
--
-- Estava como `lifetime` nos dois planos pagos: US$ 5 no Essencial e US$ 20 no
-- Pro, uma vez e para sempre. Pelo custo real medido em 2026/08/06 — US$ 0,0009
-- por resposta, ~8 respostas por agendamento — são cerca de 700 agendamentos no
-- Essencial. Uma barbearia de quatro cadeiras faz 300 a 400 por mês.
--
-- Ou seja: por volta do segundo mês o cliente que PAGA R$ 97 para de ser
-- atendido, e o produto que ele assinou some sem aviso. Uma assinatura cujo
-- recurso principal tem teto vitalício não é uma assinatura, é uma venda única
-- com cobrança recorrente.
--
-- ## O valor não muda, só o relógio
--
-- US$ 5 e US$ 20 continuam certos, e foram calculados contra o custo real. Eles
-- são LIMITE, e não gasto: a loja de quatro cadeiras consome perto de US$ 2 num
-- mês cheio, e o teto existe para o caso raro — o número que sobra é a margem
-- de segurança, não desperdício.
--
-- ## O gratuito continua vitalício, e isso está certo
--
-- Os US$ 0,50 do plano free são degustação, não mensalidade: renová-los todo mês
-- daria a uma barbearia pequena um assistente permanente de graça, que é
-- exatamente o que a migração de 2026/08/07 acabou de impedir. Prova que acaba é
-- prova; prova que renova é o produto.

update billing.plans_products
set interval = 'month'
where plan_id in ('essencial', 'pro')
  and product_id = 'ai_credits';

-- Os tiers acompanham: `cap` zero com intervalo vitalício descrevia o mesmo
-- relógio parado do outro lado da mesma regra.
update billing.tiers_products
set interval = 'month'
where tier_id in ('essencial', 'pro')
  and product_id = 'ai_credits';
