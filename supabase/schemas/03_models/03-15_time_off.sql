-- Quando NÃO se atende, fora do que a semana já diz.
--
-- A semana do profissional responde "quando eu normalmente atendo" — terça a
-- sábado, das 9h às 19h. Isto responde a exceção de um dia: nesta quinta o
-- Jorge vai ao dentista, nesta sexta é feriado, o Marcos tira férias de 15 a
-- 30, sábado a loja fecha às 13h por causa de um casamento.
--
-- Sem isto, o assistente marcava cliente em cima da folga, porque a semana diz
-- que aquele dia é dia de trabalho — e o cliente aparecia para uma cadeira
-- vazia. O único contorno era o dono criar compromissos falsos, um por horário,
-- para tapar o dia. É o tipo de coisa que faz alguém largar o sistema e voltar
-- para o caderno. - 2026/08/09
create table public.time_off (
  id uuid default gen_random_uuid() not null,
  organization_id uuid not null,
  -- Nulo é a LOJA INTEIRA: feriado, reforma, fechamento. Preenchido é de uma
  -- pessoa só.
  professional_id uuid,
  starts_at timestamp with time zone not null,
  ends_at timestamp with time zone not null,
  -- Lido por quem cuida da loja, na agenda. NUNCA vai para o cliente: ele ouve
  -- "nesse horário não temos", e o dentista do Jorge não é assunto dele.
  reason text,
  extra jsonb default '{}'::jsonb not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

alter table only public.time_off
add constraint time_off_pkey
primary key (id);

alter table only public.time_off
add constraint time_off_organization_id_fkey
foreign key (organization_id)
references public.organizations(id)
on delete cascade;

-- `cascade`, e NÃO `set null` como nos compromissos.
--
-- Aqui nulo tem significado: é "a loja inteira". Um `set null` transformaria a
-- folga pessoal de quem saiu num feriado da casa — a loja fecharia sozinha numa
-- data que ninguém escolheu, e ninguém ligaria uma coisa à outra.
alter table only public.time_off
add constraint time_off_professional_id_fkey
foreign key (professional_id)
references public.professionals(id)
on delete cascade;

-- Uma folga que termina antes de começar bloquearia nada e apareceria na tela
-- como se bloqueasse. Melhor recusar na entrada.
alter table only public.time_off
add constraint time_off_ends_after_it_starts
check (ends_at > starts_at);

-- A pergunta é sempre "o que bloqueia este dia nesta loja".
create index time_off_organization_starts_at_idx
on public.time_off
using btree (organization_id, starts_at);

create trigger set_updated_at
before update
on public.time_off
for each row
execute function public.moddatetime('updated_at');

create trigger set_extra
before update
on public.time_off
for each row
execute function public.merge_update('extra');
