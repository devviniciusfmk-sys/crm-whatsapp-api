-- Compromissos marcados com um contato.
--
-- O agente já sabe mexer na agenda do Google, quando a organização liga essa
-- ferramenta. Isto não substitui aquilo: é o registro do compromisso aqui
-- dentro, e existe por duas razões que o Google não resolve.
--
-- A primeira é o lembrete. Avisar na véspera exige saber, deste lado, o que
-- está marcado e para quem — varrer a agenda de cada cliente a cada minuto
-- seria caro e frágil, e quem não usa Google Calendar (a maioria do comércio
-- pequeno no Brasil) ficaria sem nada.
--
-- A segunda é a tela. Quem atende no painel precisa ver o dia sem sair para
-- outro produto, e precisa chegar na conversa a partir do compromisso: é o
-- mesmo cliente, e a pergunta seguinte é sempre "o que a gente combinou?".
--
-- `external_id` guarda o evento do Google quando houver, para que os dois lados
-- não virem dois compromissos. - 2026/08/02
create table public.appointments (
  id uuid default gen_random_uuid() not null,
  organization_id uuid not null,
  -- Com quem, no vocabulário que o resto do sistema já usa: serviço, número da
  -- empresa e endereço do contato identificam uma conversa.
  service public.service not null,
  organization_address text not null,
  contact_address text not null,
  -- Denormalizado para abrir a conversa direto da agenda. Fica nulo quando o
  -- compromisso nasce antes da primeira mensagem.
  conversation_id uuid,
  title text not null,
  starts_at timestamp with time zone not null,
  -- Duração em minutos, e não hora de término: é como as pessoas falam ("uma
  -- hora", "meia hora") e evita o estado impossível de terminar antes de
  -- começar.
  duration_minutes integer,
  status public.appointment_status default 'scheduled'::public.appointment_status not null,
  notes text,
  -- Evento correspondente no Google Calendar, quando sincronizado.
  external_id text,
  extra jsonb default '{}'::jsonb not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

alter table only public.appointments
add constraint appointments_pkey
primary key (id);

alter table only public.appointments
add constraint appointments_organization_id_fkey
foreign key (organization_id)
references public.organizations(id)
on delete cascade;

alter table only public.appointments
add constraint appointments_conversation_id_fkey
foreign key (conversation_id)
references public.conversations(id)
on delete set null;

-- A pergunta que esta tela faz é sempre "o que tem hoje", "o que tem amanhã".
create index appointments_organization_starts_at_idx
on public.appointments
using btree (organization_id, starts_at);

create trigger set_updated_at
before update
on public.appointments
for each row
execute function public.moddatetime('updated_at');

create trigger set_extra
before update
on public.appointments
for each row
execute function public.merge_update('extra');
