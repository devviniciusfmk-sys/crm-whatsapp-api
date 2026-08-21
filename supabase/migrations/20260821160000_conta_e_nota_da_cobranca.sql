-- Onde o dinheiro entrou e o que quem anotou quis deixar escrito.
--
-- `metodo` já dizia "pix", e uma loja com três chaves não sabia em qual
-- delas — conferir um extrato vira conferir três. E não havia onde escrever
-- nada: "pagou metade agora", "veio pelo irmão", "desconto porque indicou
-- dois" iam para o meio da conversa, onde somem para cima e não entram em
-- relatório nenhum.
--
-- Duas colunas de texto, nulas no que já existe: nenhum pagamento antigo
-- perde nada, e nenhum caminho atual precisa preenchê-las.
alter table public.cobrancas
add column if not exists conta text,
add column if not exists nota text;

comment on column public.cobrancas.conta is
  'Em qual conta/chave o dinheiro entrou — o rótulo que a loja deu, não a chave.';

comment on column public.cobrancas.nota is
  'Anotação livre de quem registrou o pagamento.';
