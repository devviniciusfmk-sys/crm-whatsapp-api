alter table public.push_subscriptions enable row level security;

-- Permissão explícita, pelo mesmo motivo que em `time_off`: os privilégios
-- padrão do projeto cobrem a produção e não cobrem um banco local montado do
-- zero pelas migrações.
grant select, insert, update, delete on public.push_subscriptions
to anon, authenticated, service_role;

-- Cada um enxerga e mexe apenas nas SUAS inscrições.
--
-- Ler as dos outros seria ler onde os colegas estão logados — que aparelho, que
-- navegador, desde quando. Não é informação de atendimento, é rastro de pessoa,
-- e não há tela nenhuma que precise dela. Quem envia é a função de borda, com
-- `service_role`, que passa por cima disto de propósito. - 2026/08/10
create policy "people manage their own push subscriptions"
on public.push_subscriptions
for all
to authenticated, anon
using (
  user_id = (select auth.uid())
  and organization_id in (
    select public.get_authorized_orgs('member')
  )
)
with check (
  user_id = (select auth.uid())
  and organization_id in (
    select public.get_authorized_orgs('member')
  )
);
