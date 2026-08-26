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

-- O gatilho que liga esta função a `public.messages` mora em
-- `04_functions_post_tables/04-09_triggers_pos_tabela_de_mensagens.sql`, não
-- aqui: `messages` só existe a partir de `03_models`, lido depois desta
-- pasta — um `create trigger ... on public.messages` aqui quebra o
-- `supabase db diff` com "relation \"public.messages\" does not exist".
-- A função pode ficar neste arquivo porque o corpo dela (que também
-- referencia `public.conversations`, também de `03_models`) só é
-- validado quando o gatilho DISPARA, não quando a função é criada.
-- - 2026/08/26
