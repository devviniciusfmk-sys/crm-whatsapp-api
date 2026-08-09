-- Aqui, e não junto das outras do cofre, porque é `language sql` e chama
-- `get_authorized_orgs`, que só nasce em 04-01.
--
-- Postgres analisa o corpo de função SQL na criação. Em 02_functions ela
-- derrubava o carregamento do esquema inteiro — e nunca deu problema em
-- produção, onde foi criada por migração, depois de tudo existir. Só aparece
-- montando o esquema do zero, que é o que `db diff` faz. - 2026/08/09
-- O que a tela pode saber: se existe, não qual é.
create function public.has_model_api_key(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path to ''
as $$
  select
    p_organization_id in (select public.get_authorized_orgs('member'))
    and exists (
      select 1 from vault.secrets
      where name = public.model_key_secret_name(p_organization_id)
    );
$$;

revoke execute on function public.has_model_api_key(uuid) from public, anon;
grant execute on function public.has_model_api_key(uuid) to authenticated;
