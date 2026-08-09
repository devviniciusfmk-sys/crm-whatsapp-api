-- Quem atende, quando a loja tem mais de uma cadeira.
--
-- Até 2026/08/09 o sistema tratava o negócio como uma cadeira só: a checagem de
-- conflito olhava apenas `organization_id`, então o primeiro cliente marcava às
-- 10h e o assistente RECUSAVA os outros três — "esse horário já tem
-- atendimento" — com três barbeiros parados. Uma barbearia de quatro perderia
-- três quartos da capacidade no primeiro dia, e nada no sistema denunciaria
-- isso: a recusa parece correta de fora.
--
-- ## Por que uma tabela, e não uma lista dentro de `organizations.extra`
--
-- Serviços moram no `extra` porque são texto e duração — não têm vida própria.
-- Um profissional tem: aparece em compromissos passados depois de sair da loja,
-- vai ganhar agenda do Google, vai ganhar horário próprio. Guardar isso em JSON
-- significaria não poder apontar para ele de `appointments` sem copiar o nome, e
-- nome copiado é nome que diverge no dia em que alguém corrige a grafia.
--
-- ## Por que não reaproveitar `agents`
--
-- Lá moram as pessoas com login e o assistente. Sobreposição é grande e a
-- diferença é o que importa: a recepcionista tem login e não é agendável; o
-- barbeiro contratado ontem é agendável e pode nunca ter login. Recurso
-- agendável não é conta de acesso, e juntar os dois cobra caro na primeira vez
-- que alguém sai da empresa. - 2026/08/09
create table public.professionals (
  id uuid default gen_random_uuid() not null,
  organization_id uuid not null,
  name text not null,
  -- Quem saiu para de aparecer na hora de marcar e continua nos compromissos
  -- que já atendeu. Apagar a linha levaria o histórico junto.
  active boolean default true not null,
  -- `services`: nomes do catálogo que esta pessoa faz. Lista vazia é "faz
  -- tudo", que é o caso da maioria e evita obrigar a marcar oito caixas para
  -- cadastrar o primeiro barbeiro.
  --
  -- `business_hours`: o horário dele dentro do horário da loja, quando difere.
  -- Ausente é "o mesmo da loja".
  --
  -- `google_calendar_id`: o calendário dele, para quando a sincronia existir.
  -- É por pessoa e não por loja porque uma agenda única não consegue dizer
  -- QUEM está ocupado — que é a pergunta inteira quando há quatro cadeiras.
  extra jsonb default '{}'::jsonb not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

alter table only public.professionals
add constraint professionals_pkey
primary key (id);

alter table only public.professionals
add constraint professionals_organization_id_fkey
foreign key (organization_id)
references public.organizations(id)
on delete cascade;

-- A pergunta é sempre "quem atende nesta loja", e quase sempre só os ativos.
create index professionals_organization_idx
on public.professionals
using btree (organization_id, active);

create trigger set_updated_at
before update
on public.professionals
for each row
execute function public.moddatetime('updated_at');

create trigger set_extra
before update
on public.professionals
for each row
execute function public.merge_update('extra');
