-- Marca na CONVERSA de qual anúncio ela veio.
--
-- O dado sempre chegou: toda mensagem que nasce de um clique em anúncio traz
-- um `referral` com o identificador, o título e o clique. Ele fica dentro do
-- `content` da mensagem — e ninguém lê o `content` de uma mensagem antiga para
-- desenhar uma lista de conversas.
--
-- Sem isto, a caixa de entrada não sabe distinguir quem chegou por anúncio de
-- quem chegou sozinho. Numa loja que anuncia, essa é a diferença entre um
-- contato e um lead pago — e é a pergunta que se faz olhando a lista, não
-- abrindo ficha por ficha. - 2026/08/18
create or replace function public.marcar_origem_da_conversa()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Só a PRIMEIRA. Quem clica num segundo anúncio meses depois já era cliente,
  -- e trocar a origem apagaria a resposta da pergunta que a loja faz: quanto
  -- este anúncio trouxe de gente nova.
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

-- `after` e não `before`: nada aqui muda a mensagem, e um gatilho que só
-- escreve noutra tabela não tem por que segurar a inserção.
--
-- `security definer` porque `conversations` não concede update a quem insere
-- mensagem. Sem isso a RLS filtraria o update em silêncio — zero linhas,
-- nenhum erro, nenhum log — que é exatamente como o cancelamento de retorno
-- passou dias parecendo funcionar em 2026/08/14.
create trigger marcar_origem
after insert
on public.messages
for each row
when (new.content -> 'referral' is not null)
execute function public.marcar_origem_da_conversa();
