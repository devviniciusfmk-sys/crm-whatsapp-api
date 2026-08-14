-- O gatilho subiu, o teste continuou vermelho, e nada dizia o motivo.
--
-- `messages` concede SELECT e INSERT, e mais nada — a conversa é um registro
-- imutável de propósito. O `delete` dentro de um gatilho comum roda com os
-- privilégios de quem inseriu, então a RLS o filtrava: zero linhas, nenhum
-- erro, nenhum log.
--
-- `security definer` resolve, e o raio de ação continua estreito: só saídas
-- daquela conversa, só no futuro, só pendentes, só marcadas como retorno. Quem
-- chega aqui já passou pela RLS de inserção — já podia escrever ali.

create or replace function public.cancel_follow_up_on_reply() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.messages
   where conversation_id = new.conversation_id
     and direction = 'outgoing'::public.direction
     and timestamp > now()
     and timestamp <= now() + interval '1 hour'
     and (status ->> 'pending') is not null
     and (status ->> 'sent') is null
     and (content ->> 'follow_up') = 'true';

  return new;
end;
$$;
