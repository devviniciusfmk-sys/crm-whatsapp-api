alter table public.professionals enable row level security;

-- Permissão de TABELA, explícita.
--
-- Em produção a tabela nasceu com isto de graça, pelos privilégios padrão do
-- projeto, e eu podei os `grant` da migração gerada confiando neles. No banco
-- local montado do zero pelas migrações os padrões são outros: a mesma tabela
-- respondia em produção e devolvia "permission denied for table professionals"
-- no local. É a divergência silenciosa que só aparece quando alguém monta o
-- ambiente do zero — que foi hoje, e por isso o ambiente local se paga.
--
-- RLS continua decidindo QUAIS linhas; isto só abre a porta da tabela.
-- - 2026/08/09
grant select, insert, update, delete on public.professionals
to anon, authenticated, service_role;

create policy "members can read their orgs professionals"
on public.professionals
for select
to authenticated, anon
using (
  organization_id in (
    select public.get_authorized_orgs('member')
  )
);

-- Admin para escrever, e não membro como nos compromissos: marcar horário é o
-- trabalho de quem atende, mas cadastrar e desligar profissional é decisão de
-- quem manda na loja. Desativar alguém tira essa pessoa de toda a agenda futura.
create policy "admins can manage their orgs professionals"
on public.professionals
for all
to authenticated, anon
using (
  organization_id in (
    select public.get_authorized_orgs('admin')
  )
);
