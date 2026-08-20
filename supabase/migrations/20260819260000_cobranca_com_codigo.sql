-- # O código Pix guardado na cobrança
--
-- Até aqui o copia-e-cola nascia, ia para a mensagem e se perdia. Servia
-- enquanto o único caminho era a conversa, onde a mensagem É o registro.
--
-- O checkout muda isso: o cliente abre a página, sai para o aplicativo do
-- banco, volta. Se o código não estiver guardado, a volta mostra uma tela
-- vazia — ou, pior, gera outro código, e aí existem duas cobranças abertas
-- para o mesmo pedido e o gateway confirma uma delas.
--
-- `expira_em` é do gateway, não nosso: o Pix dinâmico vence, e a tela precisa
-- dizer quanto falta. Passado o prazo, o código não é recusado com clareza
-- pelo banco — costuma falhar de um jeito que o cliente lê como "não funciona".
-- - 2026/08/19

alter table public.cobrancas
  add column if not exists codigo_pix text,
  add column if not exists expira_em timestamp with time zone;

comment on column public.cobrancas.codigo_pix is
  'O copia-e-cola do Pix. Guardado para a volta do banco não gerar um segundo código.';

comment on column public.cobrancas.expira_em is
  'Quando o código do gateway deixa de valer. Nulo em chave estática, que não vence.';
