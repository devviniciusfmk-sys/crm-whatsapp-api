-- O catálogo comercial: produtos, níveis e planos.
--
-- Produção tinha as sete linhas de preço de modelo (`billing.costs`) e mais
-- nada: `products`, `tiers`, `plans` e `plans_products` vazias. Sem produto não
-- há o que medir, sem nível não há teto e sem plano não há o que vender — e o
-- `ledger` tem chave estrangeira para `products`, então no dia em que o consumo
-- começasse a ser reportado, todo registro falharia.
--
-- Como no caso dos preços, tudo isto já existia no `seed.sql`, que só roda em
-- banco novo e local.
--
-- ## Duas camadas que não se misturam
--
-- `costs` é o que o provedor cobra: US$ 0,15 por milhão de tokens de entrada no
-- gpt-oss-120b, e é por esse valor que o saldo da organização é debitado.
-- `plans` é o que você vende. A margem mora na diferença, e não dentro de
-- `costs` — pôr margem lá faria o extrato do cliente mentir sobre o consumo.
--
-- ## De onde vêm os números
--
-- Medido na conversa da Bia em 2026/08/06: uma resposta custa cerca de
-- US$ 0,0005 (≈3.000 tokens de entrada, 150 de saída no gpt-oss-120b). Um
-- agendamento completo leva ~8 respostas: meio centavo de dólar. Uma barbearia
-- faz 300–600 atendimentos por mês.
--
-- Daí o crédito incluído: US$ 5 no Essencial cobre ~1.150 atendimentos, o dobro
-- do que a barbearia movimentada usa. O teto existe para conter abuso e engano
-- — laço de campanha, integração maluca —, não para racionar o uso normal.
--
-- ## Bloqueia, não vende excedente
--
-- `unit_price` nulo em toda parte: acabou o crédito, para. Cobrança surpresa é
-- o que mais gera pedido de reembolso, e um cliente que bateu no teto do
-- Essencial é um cliente pronto para o Pro — a conversa é comercial, não
-- automática.
--
-- O `cap` de um produto do tipo `balance` é piso, não teto: 0 significa "sem
-- dívida". Negativo permitiria consumir fiado.
--
-- ## Preços em reais, e o esquema não tem moeda
--
-- `plans.price` é um número sem coluna de moeda. 97 e 197 são reais. Enquanto
-- só se vender no Brasil isso não dói; no dia em que houver segunda moeda, é
-- coluna nova e migração de dados, não interpretação. Fica escrito para que
-- ninguém leia 97 como dólares. - 2026/08/06

insert into billing.products (id, name, unit, kind) values
  ('messages',      'Mensagens',    'count', 'counter'),
  ('conversations', 'Conversas',    'count', 'counter'),
  ('storage',       'Armazenamento', 'gb',   'gauge'),
  ('ai_credits',    'Créditos de IA', 'usd', 'balance')
on conflict (id) do nothing;

-- Níveis de confiança. `level` ordena: o menor é o que a organização nova
-- recebe automaticamente.
insert into billing.tiers (id, name, level) values
  ('free',      'Teste',     0),
  ('essencial', 'Essencial', 1),
  ('pro',       'Pro',       2)
on conflict (id) do nothing;

-- Tetos por nível. Sem linha aqui = sem limite.
insert into billing.tiers_products (tier_id, product_id, interval, cap) values
  ('free',      'messages',   'month',    5000),
  ('free',      'storage',    'lifetime', 1),
  ('free',      'ai_credits', 'lifetime', 0),

  ('essencial', 'messages',   'month',    25000),
  ('essencial', 'storage',    'lifetime', 25),
  ('essencial', 'ai_credits', 'lifetime', 0),

  ('pro',       'messages',   'month',    100000),
  ('pro',       'storage',    'lifetime', 100),
  ('pro',       'ai_credits', 'lifetime', 0)
on conflict (tier_id, product_id) do nothing;

-- Planos. `is_default` é o que a organização nova recebe.
insert into billing.plans (id, min_tier, price, billing_cycle, is_default) values
  ('free',      0, 0,   null,    true),
  ('essencial', 1, 97,  'month', false),
  ('pro',       2, 197, 'month', false)
on conflict (id) do nothing;

-- O que cada plano inclui. `unit_price` nulo = não vende excedente, bloqueia.
insert into billing.plans_products (plan_id, product_id, interval, included, unit_price) values
  ('free',      'messages',   'month',    5000,   null),
  ('free',      'storage',    'lifetime', 1,      null),
  ('free',      'ai_credits', 'lifetime', 1.00,   null),

  ('essencial', 'messages',   'month',    25000,  null),
  ('essencial', 'storage',    'lifetime', 25,     null),
  ('essencial', 'ai_credits', 'lifetime', 5.00,   null),

  ('pro',       'messages',   'month',    100000, null),
  ('pro',       'storage',    'lifetime', 100,    null),
  ('pro',       'ai_credits', 'lifetime', 20.00,  null)
on conflict (plan_id, product_id) do nothing;

-- As organizações que já existem NÃO recebem assinatura aqui, de propósito.
--
-- `check_limit` libera tudo quando não há assinatura, então elas seguem sem
-- teto — que é como estão hoje. Criar assinatura para elas passaria a valer
-- limite de mensagens de uma hora para outra, numa conta que já está em uso, e
-- isso é decisão de quem opera, não efeito colateral de migração.
--
-- Organização nova recebe o menor nível e o plano padrão pelo gatilho
-- `initialize_billing_subscription`, que já existia e nunca teve o que ler.
