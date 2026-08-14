-- O retorno que não faz mais sentido.
--
-- "Me chama às 19h" vira uma mensagem parada com carimbo futuro. Se às 18h40 o
-- cliente escreve de novo, às 19h chega "Oi, você pediu para eu falar com você
-- às 19h" — em cima de uma conversa que está acontecendo naquele instante.
--
-- Uma hora, e não qualquer resposta: o retorno existe porque a PESSOA pediu, e
-- um "obrigado" trinta segundos depois do pedido cancelaria justamente a
-- promessa que o recurso existe para cumprir. Ver o comentário longo em
-- `schemas/02_functions/02-03_trigger_functions.sql`.

create or replace function public.cancel_follow_up_on_reply() returns trigger
language plpgsql
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

drop trigger if exists cancel_follow_up_on_reply on public.messages;

create trigger cancel_follow_up_on_reply
after insert
on public.messages
for each row
when (
  new.direction = 'incoming'::public.direction
  and new.timestamp <= now()
  and new.timestamp >= now() - interval '10 seconds'
)
execute function public.cancel_follow_up_on_reply();
