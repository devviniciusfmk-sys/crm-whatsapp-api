-- Marca na conversa de qual anúncio ela veio, e repara as que já chegaram.
--
-- O `referral` sempre chegou dentro do `content` da mensagem, e ninguém lê o
-- conteúdo de uma mensagem antiga para desenhar uma lista de conversas. O
-- resultado é que a caixa de entrada não distinguia quem veio de anúncio de
-- quem chegou sozinho — que numa loja que anuncia é a diferença entre um
-- contato e um lead pago.
--
-- A segunda parte marca as que já existem. Sem ela o recurso só valeria para
-- quem chegasse a partir de agora, e a loja veria metade da lista marcada sem
-- entender o critério. - 2026/08/18

create or replace function public.marcar_origem_da_conversa()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.conversations
  set extra = jsonb_build_object(
    'anuncio',
    jsonb_build_object(
      'id', new.content -> 'referral' ->> 'source_id',
      'tipo', new.content -> 'referral' ->> 'source_type',
      'titulo', new.content -> 'referral' ->> 'headline',
      'clique', new.content -> 'referral' ->> 'ctwa_clid',
      'em', new.timestamp
    )
  )
  where id = new.conversation_id
    and (extra -> 'anuncio') is null;

  return null;
end;
$$;

drop trigger if exists marcar_origem on public.messages;

create trigger marcar_origem
after insert
on public.messages
for each row
when (new.content -> 'referral' is not null)
execute function public.marcar_origem_da_conversa();

-- O reparo: a PRIMEIRA mensagem com anúncio de cada conversa que ainda não
-- está marcada.
with primeira as (
  select distinct on (m.conversation_id)
    m.conversation_id,
    m.content -> 'referral' as referral,
    m.timestamp
  from public.messages m
  join public.conversations c on c.id = m.conversation_id
  where m.content -> 'referral' is not null
    and (c.extra -> 'anuncio') is null
  order by m.conversation_id, m.timestamp asc
)
update public.conversations c
set extra = coalesce(c.extra, '{}'::jsonb) || jsonb_build_object(
  'anuncio',
  jsonb_build_object(
    'id', p.referral ->> 'source_id',
    'tipo', p.referral ->> 'source_type',
    'titulo', p.referral ->> 'headline',
    'clique', p.referral ->> 'ctwa_clid',
    'em', p.timestamp
  )
)
from primeira p
where c.id = p.conversation_id;
