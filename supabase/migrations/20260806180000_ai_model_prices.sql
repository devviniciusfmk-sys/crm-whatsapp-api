-- Preços dos modelos, para que o crédito do plano exista.
--
-- A `billing.costs` estava VAZIA em produção. Sem preço, o caminho "crédito da
-- plataforma" lança `No pricing found for <provedor>/<modelo>` ANTES de chamar
-- o modelo — então nenhum assistente sem chave própria jamais respondeu uma
-- mensagem, em nenhuma organização. Descoberto medindo uma conversa de verdade
-- em 2026/08/06, não lendo código.
--
-- As linhas já existiam no `seed.sql`, que só roda em banco novo e local. É por
-- isso que funcionava no desenvolvimento e não em produção — a diferença mais
-- cara de perceber que existe.
--
-- ## Isto é custo, não preço de venda
--
-- É quanto o provedor cobra, e é por esse valor que o saldo de `ai_credits` da
-- organização é debitado. A margem não mora aqui: mora no que você cobra para
-- vender crédito. Misturar as duas coisas nesta tabela faria o extrato do
-- cliente mentir sobre o consumo dele.
--
-- ## Só os quatro provedores com chave da plataforma
--
-- Crédito do plano usa as chaves do servidor (GROQ_API_KEY, GOOGLE_API_KEY,
-- ANTHROPIC_API_KEY, OPENAI_API_KEY). OpenRouter e NVIDIA exigem chave do
-- cliente e nunca passam por aqui — para eles o `billable` é falso e a consulta
-- de preço nem acontece.
--
-- Valores conforme a documentação de cada provedor, por milhão de tokens:
--   Groq       https://groq.com/pricing
--   Google     https://ai.google.dev/gemini-api/docs/pricing
--   Anthropic  https://platform.claude.com/docs/en/about-claude/pricing
--   OpenAI     https://developers.openai.com/api/docs/pricing
--
-- `on conflict do nothing` porque a chave primária inclui `effective_at`: um
-- reajuste é uma linha nova com data nova, e o código já lê a mais recente que
-- não seja futura. Nada aqui reescreve histórico.

insert into billing.costs (provider, product, quantity, unit, pricing) values
  ('groq',      'openai/gpt-oss-20b',     1000000, 'tokens', '{"input": 0.075, "output": 0.30, "cache_read": 0.037}'),
  ('groq',      'openai/gpt-oss-120b',    1000000, 'tokens', '{"input": 0.15, "output": 0.60, "cache_read": 0.075}'),
  ('google',    'gemini-2.5-flash',       1000000, 'tokens', '{"input": 0.30, "output": 2.50, "cache_read": 0.03, "audio_input": 1.00, "audio_cache_read": 0.10}'),
  ('google',    'gemini-3-flash-preview', 1000000, 'tokens', '{"input": 0.50, "output": 3.00, "cache_read": 0.05, "audio_input": 1.00, "audio_cache_read": 0.10}'),
  ('anthropic', 'claude-sonnet-4-6',      1000000, 'tokens', '{"input": 3.00, "output": 15.00, "cache_read": 0.30, "cache_write": 3.75}'),
  ('openai',    'gpt-5-mini',             1000000, 'tokens', '{"input": 0.25, "output": 2.00, "cache_read": 0.03}'),
  ('openai',    'gpt-5.3-chat-latest',    1000000, 'tokens', '{"input": 1.75, "output": 14.00, "cache_read": 0.18}')
on conflict (provider, product, effective_at) do nothing;
