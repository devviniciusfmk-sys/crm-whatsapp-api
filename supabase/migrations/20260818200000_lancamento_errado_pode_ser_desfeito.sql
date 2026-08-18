-- Uma forma de pagamento lançada errada não podia ser desfeita.
--
-- O gatilho `set_extra` de `appointments` roda em TODA atualização, sem a
-- guarda que `contacts`, `conversations`, `organizations` e mais três têm. Ele
-- mescla o que veio por cima do que estava, então uma chave escrita no `extra`
-- nunca mais sai: quem lançou "pix" num atendimento que era fiado ficava com
-- pix para sempre, e não havia caminho nenhum — nem pela tela, nem pela API —
-- para corrigir.
--
-- Num compromisso isso é dinheiro, e "lancei errado" é a coisa mais comum que
-- acontece num caixa de barbearia.
--
-- Com a guarda, mandar `extra` nulo limpa a coluna. Nada no produto manda nulo
-- hoje, então isto só abre uma porta que estava murada — nenhum comportamento
-- existente muda. - 2026/08/18

drop trigger if exists set_extra on public.appointments;

create trigger set_extra
before update
on public.appointments
for each row
when (
  new.extra is not null
)
execute function public.merge_update('extra');
