-- Quem quer um horário que não tem.
--
-- Hoje o dia cheio é uma porta fechada: o cliente ouve "não temos" e vai
-- procurar outro lugar. Enquanto isso alguém cancela às 15h e a cadeira fica
-- vazia — as duas coisas no mesmo dia, sem que uma saiba da outra. É a perda
-- mais silenciosa de uma barbearia, porque não aparece em lugar nenhum: nem
-- como cliente perdido, nem como horário ocioso.
--
-- Uma linha aqui é UM PEDIDO, não uma pessoa. A mesma pessoa pode querer
-- quarta de manhã e sexta à tarde, e são dois pedidos com desfechos
-- independentes.
--
-- ## O estado, e por que ele é um campo e não uma dedução
--
-- `waiting` espera; `offered` já recebeu o convite e o relógio está correndo;
-- `taken` virou compromisso; `expired` não respondeu a tempo; `cancelled`
-- desistiu ou o dia passou. Deduzir isso de datas — "tem `offered_at` e não tem
-- `booked_at`, logo está esperando resposta" — funciona até o dia em que uma
-- terceira data entra e a conta muda em quatro lugares. - 2026/08/10
create type public.waitlist_status as enum (
  'waiting',
  'offered',
  'taken',
  'expired',
  'cancelled'
);

create table public.waitlist (
  id uuid default gen_random_uuid() not null,
  organization_id uuid not null,
  -- Por onde avisar. É a conversa em que o pedido nasceu, e é nela que o
  -- convite vai cair.
  conversation_id uuid not null,
  contact_address text not null,
  service public.service not null,
  organization_address text not null,
  -- O que a pessoa quer, nas palavras dela: "corte", "corte + barba".
  title text,
  /**
   * O dia que ela quer. Nulo é "qualquer dia".
   *
   * Data e não intervalo: quem espera encaixe está de olho num dia — o
   * casamento é sábado, a viagem é quinta. "Qualquer dia" existe para quem só
   * quer o mais cedo possível, e é um pedido diferente, não um intervalo
   * grande.
   */
  desired_date date,
  -- Nulo é "tanto faz o horário". `morning` e `afternoon` são o que o cliente
  -- realmente diz — ninguém pede "entre 9h e 12h".
  desired_period text,
  -- Só quando pediram alguém em particular. Nulo é "qualquer profissional", que
  -- é o caso da maioria e o que preenche a cadeira mais rápido.
  professional_id uuid,
  status public.waitlist_status default 'waiting' not null,
  -- Quando o convite foi mandado. É daqui que o prazo de resposta corre.
  offered_at timestamp with time zone,
  -- Qual horário foi oferecido, para o convite poder ser conferido depois e
  -- para saber o que virou compromisso.
  offered_for timestamp with time zone,
  extra jsonb default '{}'::jsonb not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

alter table only public.waitlist
add constraint waitlist_pkey
primary key (id);

alter table only public.waitlist
add constraint waitlist_organization_id_fkey
foreign key (organization_id)
references public.organizations(id)
on delete cascade;

alter table only public.waitlist
add constraint waitlist_conversation_id_fkey
foreign key (conversation_id)
references public.conversations(id)
on delete cascade;

-- `set null` e não `cascade`: o pedido de quem queria o Jorge continua válido
-- quando o Jorge sai da equipe — vira "qualquer profissional", que é o que a
-- pessoa aceitaria de qualquer forma antes de perder a vaga.
alter table only public.waitlist
add constraint waitlist_professional_id_fkey
foreign key (professional_id)
references public.professionals(id)
on delete set null;

-- A pergunta do encaixe é sempre "quem espera nesta loja, na ordem em que
-- pediu": o primeiro a pedir é o primeiro a ser chamado, e é a única ordem que
-- não precisa ser explicada a um cliente irritado.
create index waitlist_organization_status_idx
on public.waitlist
using btree (organization_id, status, created_at);

create trigger set_updated_at
before update
on public.waitlist
for each row
execute function public.moddatetime('updated_at');

create trigger set_extra
before update
on public.waitlist
for each row
execute function public.merge_update('extra');
