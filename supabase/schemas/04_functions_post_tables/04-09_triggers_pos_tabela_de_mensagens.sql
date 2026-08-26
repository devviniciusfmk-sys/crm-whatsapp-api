-- Os gatilhos de `public.marcar_origem_da_conversa()`
-- (`02_functions/02-05_origem_da_conversa.sql`) e
-- `public.marcar_dono_da_conversa()` (`02_functions/02-06_dono_da_conversa.sql`),
-- separados das funções por causa da ordem em que `supabase db diff` lê as
-- pastas: `02_functions` vem antes de `03_models`, e `public.messages` só
-- existe a partir de lá. Um `create trigger ... on public.messages` dentro
-- de `02_functions` falhava com "relation \"public.messages\" does not
-- exist" — achado ao tentar gerar a migração da loja de números em
-- 2026/08/26, sem relação nenhuma com ela.
--
-- `after` e não `before` nos dois: nada aqui muda a mensagem, e um gatilho
-- que só escreve noutra tabela não tem por que segurar a inserção.
--
-- `security definer` nos dois porque `conversations` não concede update a
-- quem insere mensagem. Sem isso a RLS filtraria o update em silêncio —
-- zero linhas, nenhum erro, nenhum log — que é exatamente como o
-- cancelamento de retorno passou dias parecendo funcionar em 2026/08/14.
create trigger marcar_origem
after insert
on public.messages
for each row
when (new.content -> 'referral' is not null)
execute function public.marcar_origem_da_conversa();

create trigger marcar_dono
after insert
on public.messages
for each row
when (new.direction = 'outgoing' and new.agent_id is not null)
execute function public.marcar_dono_da_conversa();
