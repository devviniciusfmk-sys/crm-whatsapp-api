
-- ## O token vai junto quando o servidor vai
--
-- Sem isto, apagar um painel deixa o segredo dele no cofre para sempre.
-- Ninguém consegue ler — `get_iptv_token` e `has_iptv_token` conferem o
-- servidor, que já não existe —, mas ele fica lá: um segredo que a tela
-- prometeu poder remover e que nenhuma tela alcança mais.
--
-- Medido na primeira prova do módulo, em 2026/08/22: apaguei o servidor e o
-- segredo continuou no cofre.
create or replace function public.apagar_token_do_servidor()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
begin
  delete from vault.secrets
  where name = public.iptv_token_secret_name(old.id);

  return old;
end;
$$;

drop trigger if exists apagar_token on public.iptv_servidores;

create trigger apagar_token
after delete on public.iptv_servidores
for each row execute function public.apagar_token_do_servidor();
