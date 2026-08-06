-- O saldo deixa de se chamar "Créditos de IA".
--
-- Ele passa a ser debitado também pelo envio de modelo no WhatsApp, que é a
-- despesa que a Meta cobra por mensagem — e que até hoje não era contada por
-- ninguém. Um saldo chamado "de IA" que paga tarifa de WhatsApp é um nome que
-- mente para o cliente na única tela onde ele confere dinheiro.
--
-- Só o nome muda. O `id` continua `ai_credits`: ele aparece no código das
-- funções, nas chaves estrangeiras do extrato e nas linhas de plano já
-- gravadas. Renomear identificador para arrumar rótulo é trocar um problema
-- visível por um invisível. - 2026/08/06

update billing.products
set name = 'Créditos'
where id = 'ai_credits';
