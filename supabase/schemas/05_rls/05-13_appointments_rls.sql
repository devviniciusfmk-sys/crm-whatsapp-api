alter table public.appointments enable row level security;

/**
 * Quem é profissional vê a agenda DELE. Quem não é vê a da casa.
 *
 * O barbeiro passou a entrar no sistema em 2026/08/10, e a agenda abria
 * filtrada nele — filtrada, não isolada. Bastava clicar em "Todos" para ver a
 * agenda dos colegas, com nome de cliente e valor de cada atendimento. Quanto o
 * Marcos faturou ontem é assunto do dono, não do Jorge.
 *
 * ## Por que aqui, e não no papel do usuário
 *
 * O caminho óbvio seria um quarto papel — dono, admin, membro, profissional — e
 * mexer em `get_authorized_orgs`. Essa função decide a permissão de TODAS as
 * tabelas do sistema: um erro nela não quebra a agenda, vaza ou bloqueia dados
 * em tudo. A condição cabe aqui dentro, e aqui dentro o pior caso é a agenda.
 *
 * ## Quem é "profissional"
 *
 * Quem tem uma ficha de equipe apontando para a conta dele (`extra.agent_id`).
 * Ninguém marca isso num campo de papel: já existe o vínculo, e uma segunda
 * chave dizendo a mesma coisa seria uma chance de as duas discordarem.
 *
 * Sem vínculo — dono, admin, quem está no balcão — nada muda: a casa inteira,
 * como sempre foi. E com chave de API `auth.uid()` é nulo, então nenhuma ficha
 * casa e o acesso continua o de antes, que é o certo para integração.
 *
 * A comparação é de TEXTO e não com `::uuid`: um `extra.agent_id` escrito
 * errado à mão derrubaria a consulta inteira com erro de conversão, e uma
 * política que estoura é uma tela em branco sem explicação. - 2026/08/11
 */
create or replace function public.professional_of_caller(_organization_id uuid)
returns uuid
language sql
stable
security definer
set search_path to ''
as $$
  select p.id
  from public.professionals as p
  join public.agents as a
    on a.id::text = p.extra ->> 'agent_id'
  where p.organization_id = _organization_id
    and a.user_id = (select auth.uid())
  limit 1;
$$;

grant execute on function public.professional_of_caller(uuid)
to anon, authenticated, service_role;

create policy "members see their orgs appointments"
on public.appointments
for select
to authenticated, anon
using (
  organization_id in (
    select public.get_authorized_orgs('member')
  )
  and (
    public.professional_of_caller(organization_id) is null
    or professional_id = public.professional_of_caller(organization_id)
  )
);

-- Membro, e não admin: quem atende é quem marca. Uma agenda que só o dono pode
-- mexer não é agenda de atendimento, é relatório.
--
-- A mesma regra do enxergar vale para o mexer: o barbeiro não desmarca o
-- cliente do colega.
create policy "members manage their orgs appointments"
on public.appointments
for all
to authenticated, anon
using (
  organization_id in (
    select public.get_authorized_orgs('member')
  )
  and (
    public.professional_of_caller(organization_id) is null
    or professional_id = public.professional_of_caller(organization_id)
  )
)
with check (
  organization_id in (
    select public.get_authorized_orgs('member')
  )
  and (
    public.professional_of_caller(organization_id) is null
    or professional_id = public.professional_of_caller(organization_id)
  )
);
