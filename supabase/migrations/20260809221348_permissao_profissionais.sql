-- Permissão de tabela para `professionals`, explícita.
--
-- Gerada por `supabase db diff` e PODADA à mão, pelo mesmo motivo da migração
-- que criou a tabela: o diff traz 168 `revoke` em todas as tabelas do sistema —
-- diferença entre as concessões que a produção tem e as que os arquivos de
-- esquema declaram — e aplicá-las tiraria o acesso do aplicativo inteiro.
-- Sobrou o que esta migração é.
--
-- ## Por que ela existe
--
-- Em produção a tabela nasceu com permissão de graça, pelos privilégios padrão
-- do projeto, e os `grant` da migração anterior foram podados confiando neles.
-- No banco local montado do zero pelas migrações, os padrões são outros: a
-- MESMA tabela respondia em produção e devolvia "permission denied for table
-- professionals" no local.
--
-- É a divergência que só aparece quando alguém monta o ambiente do zero — e
-- foi a primeira coisa que o ambiente local encontrou, no dia em que passou a
-- existir. Depender de privilégio padrão é depender de uma configuração que
-- não está escrita em lugar nenhum. - 2026/08/09

grant select, insert, update, delete on table "public"."professionals"
to "anon";

grant select, insert, update, delete on table "public"."professionals"
to "authenticated";

grant select, insert, update, delete on table "public"."professionals"
to "service_role";
