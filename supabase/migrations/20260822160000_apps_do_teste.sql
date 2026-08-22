-- Os aplicativos que o painel ofereceu, com o código de cada um.
--
-- Vem de dentro do `reply` — o painel não os manda em campo nenhum, só dentro
-- do texto que ele escreve para gente ler. Guardados aqui, dá para reenviar o
-- código de OUTRO app depois, sem gerar credencial nova.
--
-- E é isso que faz o reuso valer para qualquer app: neste painel a mesma dupla
-- usuário/senha serve os quinze aplicativos, e o que muda entre eles é só o
-- código de ativação. Medido em 2026/08/22.
--
-- `[{"nome":"Super Play","codigo":"00330"}, …]`
alter table public.iptv_testes
add column if not exists apps jsonb default '[]'::jsonb;

comment on column public.iptv_testes.apps is
  'Os apps que o painel ofereceu, lidos do texto da resposta. Nome e código.';
