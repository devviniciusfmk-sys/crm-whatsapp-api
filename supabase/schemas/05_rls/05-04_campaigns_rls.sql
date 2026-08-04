alter table public.campaigns enable row level security;

create policy "members can read their orgs campaigns"
on public.campaigns
for select
to authenticated, anon
using (
  organization_id in (
    select public.get_authorized_orgs('member')
  )
);

-- Admin para escrever, e não member como na agenda.
--
-- Marcar um compromisso errado atrapalha uma pessoa. Disparar uma campanha
-- errada fala com a base inteira de uma vez, gasta conversa paga e pode
-- queimar a nota de qualidade do número — e número queimado leva junto todos
-- os outros do portfólio, porque desde outubro de 2025 a Meta conta o limite
-- por portfólio e não por número.
--
-- É a mesma régua já usada em agents, webhooks e quick_replies: quem configura
-- o que o sistema faz sozinho é admin; quem atende é member. - 2026/08/03
create policy "admins can manage their orgs campaigns"
on public.campaigns
for all
to authenticated, anon
using (
  organization_id in (
    select public.get_authorized_orgs('admin')
  )
);
