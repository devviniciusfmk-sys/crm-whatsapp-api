-- Quem respondeu primeiro é o dono da conversa.
--
-- ## Por que "quem responde" e não um sorteio
--
-- Os CRMs grandes distribuem em rodízio, e o rodízio existe para resolver um
-- problema que esta loja não tem: vendedor comissionado escolhendo os leads
-- bons e deixando o resto. Numa equipe de dois a quatro pessoas que se veem na
-- mesma sala, rodízio joga a conversa em quem está de máquina na mão cortando
-- cabelo — e ela fica parada esperando alguém que não pode atender.
--
-- O problema REAL de uma caixa compartilhada é outro: duas pessoas respondendo
-- o mesmo cliente. Marcar dono no primeiro que responde resolve exatamente
-- isso, sem configuração nenhuma e sem ninguém precisar declarar que está
-- disponível.
--
-- Se um dia a resposta gerar comissão, o incentivo de escolher a conversa boa
-- aparece e o rodízio passa a ter função — mas aí ele é acrescentado por cima
-- disto, não no lugar disto: o dono continua sendo o dado, e o rodízio vira só
-- outra forma de defini-lo.
--
-- ## O ASSISTENTE não vira dono
--
-- `agents` guarda gente e robô na mesma tabela, separados por `ai`. Sem o
-- filtro, a primeira resposta automática marcaria o assistente como dono de
-- TODA conversa — e a lista mostraria "com Bia" em cima de tudo, que é o mesmo
-- que não mostrar nada.
--
-- ## O primeiro, e só ele
--
-- Quem entra depois para ajudar não rouba a conversa. Dono que muda a cada
-- mensagem é dono de ninguém, e a pergunta que a lista responde — "quem está
-- cuidando disto?" — passaria a responder "o último que digitou".
-- - 2026/08/21
create or replace function public.marcar_dono_da_conversa()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.conversations
  set extra = coalesce(extra, '{}'::jsonb) || jsonb_build_object(
    'dono',
    jsonb_build_object('agente', new.agent_id, 'em', new.timestamp)
  )
  where id = new.conversation_id
    and (extra -> 'dono') is null
    -- Gente, e não o assistente.
    and exists (
      select 1 from public.agents a
      where a.id = new.agent_id and a.ai = false
    );

  return null;
end;
$$;

-- `||` e não `jsonb_build_object` puro: `marcar_origem` PODE sobrescrever o
-- extra inteiro porque roda uma vez, no primeiro contato, quando não há mais
-- nada lá. Aqui não — a conversa já tem `paused`, `handoff`, `draft`, e
-- trocar o objeto apagaria os três em silêncio.
--
-- `after` e `security definer` pelos mesmos motivos de `marcar_origem`: nada
-- aqui muda a mensagem, e sem `security definer` a RLS filtraria o update sem
-- erro, sem log e sem linha nenhuma alterada.
create trigger marcar_dono
after insert
on public.messages
for each row
when (new.direction = 'outgoing' and new.agent_id is not null)
execute function public.marcar_dono_da_conversa();
