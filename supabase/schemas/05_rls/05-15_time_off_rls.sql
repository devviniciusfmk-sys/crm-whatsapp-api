alter table public.time_off enable row level security;

-- Permissão de tabela explícita, e não herdada dos privilégios padrão.
--
-- A tabela `professionals` nasceu sem isto: respondia em produção, onde os
-- padrões do projeto a cobriam, e devolvia "permission denied" no banco local
-- montado do zero pelas migrações. Levou meia hora para achar. Escrito aqui,
-- os dois ambientes se comportam igual. - 2026/08/09
grant select, insert, update, delete on public.time_off
to anon, authenticated, service_role;

create policy "members can read their orgs time off"
on public.time_off
for select
to authenticated, anon
using (
  organization_id in (
    select public.get_authorized_orgs('member')
  )
);

-- Membro, e não admin como no cadastro de profissional: bloquear horário é ato
-- de atendimento, igual a marcar. Quem está no balcão quando o barbeiro avisa
-- que vai ao médico precisa poder bloquear na hora — mandar esperar o dono é
-- garantir que o bloqueio não acontece e o cliente vai à cadeira vazia.
create policy "members can manage their orgs time off"
on public.time_off
for all
to authenticated, anon
using (
  organization_id in (
    select public.get_authorized_orgs('member')
  )
);
