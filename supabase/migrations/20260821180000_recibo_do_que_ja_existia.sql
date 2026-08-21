-- O que já existia conta como avisado.
--
-- `recibo_em` nasceu nula em toda linha antiga, e a tela lista o que está sem
-- marca. Sem este passo, no primeiro dia a loja abre "Pagos sem aviso" e vê
-- TODO pagamento da última semana — inclusive os que receberam confirmação
-- normalmente. Quem tocasse em cada botão mandaria uma segunda confirmação
-- para cada cliente, e um cliente que recebe "pagamento confirmado" duas vezes
-- entende que pagou duas vezes.
--
-- Não dá para saber quais foram avisados de fato: a marca não existia. Entre
-- os dois erros possíveis, este é o barato — um recibo perdido lá atrás segue
-- perdido, e ninguém recebe uma enxurrada. Daqui para a frente a marca é
-- escrita no envio, e a lista passa a dizer a verdade.
--
-- `paga_em` e não `now()`: a marca é quando o cliente foi avisado, e a melhor
-- aproximação que existe é o instante do pagamento — carimbar hoje faria o
-- histórico dizer que a loja avisou todo mundo na data da migração.
update public.cobrancas
set recibo_em = coalesce(paga_em, updated_at)
where status = 'paga'
  and recibo_em is null;
