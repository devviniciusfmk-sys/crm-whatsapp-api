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
  -- Quanto custa e quanto já entrou.
  --
  -- Guardado no compromisso, e não só no catálogo de serviços, porque preço
  -- muda: o corte que custa 45 hoje custa 55 em outubro, e o histórico tem de
  -- continuar dizendo o que foi cobrado naquele dia. O catálogo é o valor
  -- sugerido na hora de marcar; isto é o valor daquele atendimento.
  --
  -- `numeric`, como o resto do dinheiro deste banco (billing.payments.amount).
  -- Nulo é "ninguém precificou", que não é a mesma coisa que zero — zero é o
  -- atendimento de cortesia, e a diferença aparece em qualquer relatório.
  price numeric,
  -- Sinal pago para segurar o horário. Só registro: nada aqui move dinheiro, e
  -- quem confirma o recebimento é quem atende. - 2026/08/03
  deposit numeric,
  notes text,
  -- Evento correspondente no Google Calendar, quando sincronizado.
  external_id text,
  -- Quem atende, quando a loja tem mais de uma cadeira.
  --
  -- Nulo em duas situações legítimas: compromissos anteriores a 2026/08/09,
  -- quando o sistema achava que toda loja tinha uma cadeira só, e negócios de
  -- uma pessoa, que não têm por que cadastrar ninguém.
  professional_id uuid,
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

-- `set null`, e não `cascade`: o compromisso de ontem continua existindo quando
-- o profissional sai do cadastro. Perder o histórico de atendimento por causa de
-- uma demissão seria destruir o dado mais valioso da loja.
alter table only public.appointments
add constraint appointments_professional_id_fkey
foreign key (professional_id)
references public.professionals(id)
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

-- Com a guarda, como em `contacts`, `conversations` e mais quatro — mas aqui
-- ela quase nunca dispara, e está por consistência.
--
-- A migração que a trouxe (20260818200000) dizia que ela permitiria limpar o
-- `extra` mandando nulo. Não permite: esta coluna é NOT NULL, e nulo nunca
-- chega ao gatilho. Medido antes de acreditar, e a promessa era minha.
--
-- ## Como se desfaz um lançamento errado, então
--
-- Mandando `{"payment_method": null}`. A mesclagem grava a chave com valor
-- nulo — ela não some do JSON —, e `->>` devolve NULL, que é o que todo leitor
-- do produto entende por "sem pagamento": a visão de contatos, o caixa e a
-- fidelidade. "Lancei pix e era fiado" é a coisa mais comum que acontece num
-- caixa de barbearia, e este é o caminho. - 2026/08/18
create trigger set_extra
before update
on public.appointments
for each row
when (
  new.extra is not null
)
execute function public.merge_update('extra');
