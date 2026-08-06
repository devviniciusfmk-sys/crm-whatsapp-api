-- Preços da OpenRouter, para que ela possa rodar no crédito da plataforma.
--
-- Até agora a OpenRouter era o único provedor que **exigia** chave do cliente:
-- o endereço dela é uma URL inteira e não um apelido, então caía no `default`
-- do seletor e saía de lá como `provider: "custom"`, sem chave de ambiente para
-- recorrer. Nenhum preço podia ser encontrado, porque "custom/<modelo>" não é
-- linha que alguém cadastre.
--
-- O código passou a chamá-la pelo nome. Estas são as linhas que faltavam.
--
-- Valores lidos da API pública deles em 2026/08/06
-- (https://openrouter.ai/api/v1/models), não da memória de ninguém. São por
-- milhão de tokens, como as demais.
--
-- A OpenRouter roteia entre fornecedores e o preço varia com quem atende a
-- chamada; o que está aqui é o anunciado para o modelo. Enquanto a margem for a
-- que é — o Essencial cobra R$ 97 e gasta US$ 5 —, a diferença cabe folgada
-- dentro dela. No dia em que não couber, o caminho é ler o custo real que a
-- própria resposta traz, e não adivinhar melhor.
--
-- `claude-sonnet-4-6` não entra: não está no catálogo da OpenRouter. Quem
-- quiser Claude usa o provedor Anthropic direto, que já tem preço.

insert into billing.costs (provider, product, quantity, unit, pricing) values
  ('openrouter', 'openai/gpt-oss-120b',   1000000, 'tokens', '{"input": 0.037, "output": 0.17}'),
  ('openrouter', 'openai/gpt-oss-20b',    1000000, 'tokens', '{"input": 0.03, "output": 0.13, "cache_read": 0.03}'),
  ('openrouter', 'google/gemini-2.5-flash', 1000000, 'tokens', '{"input": 0.30, "output": 2.50, "cache_read": 0.03}')
on conflict (provider, product, effective_at) do nothing;
