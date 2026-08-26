-- Os gatilhos que apagam um segredo do Vault quando a linha dona dele
-- some, separados de `02_functions/02-05_vault_secrets.sql` pela mesma
-- razão de `04-09_triggers_pos_tabela_de_mensagens.sql`: `create trigger ... on
-- public.iptv_servidores`/`public.loja_numeros` precisa que a tabela já
-- exista, e `02_functions` é lida antes de `03_models`. As FUNÇÕES ficam
-- no arquivo original — só a amarração com a tabela muda de lugar.
--
-- Achado ao gerar a migração da loja de números em 2026/08/26; o do IPTV
-- é anterior e sem relação com ela, quebrando pelo mesmo motivo.

drop trigger if exists apagar_token on public.iptv_servidores;

create trigger apagar_token
after delete on public.iptv_servidores
for each row execute function public.apagar_token_do_servidor();

drop trigger if exists apagar_token_numero_loja on public.loja_numeros;

create trigger apagar_token_numero_loja
after delete on public.loja_numeros
for each row execute function public.apagar_token_do_numero_loja();
