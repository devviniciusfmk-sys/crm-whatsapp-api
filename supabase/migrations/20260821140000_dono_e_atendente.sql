-- Quem atendeu: dono da conversa e atendente da venda.
--
-- Duas coisas que faltavam para uma loja com mais de uma pessoa no balcão.
--
--   O DONO DA CONVERSA   resolve o problema real de caixa compartilhada: duas
--                        pessoas respondendo o mesmo cliente. Quem responde
--                        primeiro assume, e os outros passam a ver.
--   O ATENDENTE DA VENDA dá à comissão de quem contar. "A loja faturou
--                        R$ 3.400" não responde quanto cada um trouxe.
--
-- O dono mora no `extra` da conversa; o atendente vira coluna na cobrança,
-- porque é dinheiro e dinheiro se soma por pessoa em relatório.

alter table public.cobrancas
add column if not exists agent_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'cobrancas_agent_id_fkey'
  ) then
    alter table public.cobrancas
    add constraint cobrancas_agent_id_fkey
    foreign key (agent_id)
    references public.agents(id)
    -- Demitir um atendente não pode apagar o faturamento dele do caixa.
    on delete set null;
  end if;
end
$$;

-- A pergunta do fim do mês: quanto cada um vendeu neste período.
create index if not exists cobrancas_agent_id_idx
on public.cobrancas (organization_id, agent_id)
where agent_id is not null;

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
    -- Gente, e não o assistente: `agents` guarda os dois na mesma tabela, e sem
    -- este filtro a primeira resposta automática marcaria o robô como dono de
    -- toda conversa.
    and exists (
      select 1 from public.agents a
      where a.id = new.agent_id and a.ai = false
    );

  return null;
end;
$$;

drop trigger if exists marcar_dono on public.messages;

create trigger marcar_dono
after insert
on public.messages
for each row
when (new.direction = 'outgoing' and new.agent_id is not null)
execute function public.marcar_dono_da_conversa();
