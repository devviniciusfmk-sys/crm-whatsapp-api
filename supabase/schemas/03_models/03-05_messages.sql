-- organization_id is useful for realtime. It could be argued that if there
-- is organization_id then there is room for contact_id, but it is not necessary now.
create table public.messages (
  organization_id uuid not null,
  conversation_id uuid not null,
  id uuid default gen_random_uuid() not null,
  external_id text,
  direction public.direction not null,
  agent_id uuid, -- internal sender (should be not null for internal and outgoing)
  contact_address text, -- external sender (should be not null for incoming)
  -- denormalized properties
  service public.service not null,
  organization_address text not null,
  group_address text,
  -- Logical partition of a conversation (Slack/Discord-style threads): the
  -- external_id of the thread's root message, shared by the root (which points
  -- to itself) and all of its replies. null = top-level / main channel
  -- timeline. Soft reference like content.re_message_id — not a FK, so it
  -- tolerates out-of-order arrival and out-of-window roots.
  thread_id text,
  -- Campanha que gerou esta mensagem, quando houve uma. Nula na esmagadora
  -- maioria das linhas.
  --
  -- Está aqui, e não numa tabela `campaign_recipients`, porque uma tabela de
  -- destinatários seria uma segunda cópia do estado de entrega: o webhook
  -- atualiza `messages`, alguém esquece de propagar, e o painel passa a mentir.
  -- Com a coluna na própria mensagem, "enviadas / entregues / lidas / falhas" é
  -- um `group by` sobre a fonte única, e não há o que divergir.
  --
  -- O custo é um uuid nulo numa tabela quente; os dois índices abaixo são
  -- parciais, então linha sem campanha não paga por eles. - 2026/08/03
  campaign_id uuid,
  ----
  content jsonb not null,
  status jsonb default jsonb_build_object('pending', now()) not null,
  timestamp timestamp with time zone default now() not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

alter table only public.messages
add constraint messages_organization_id_fkey
foreign key (organization_id)
references public.organizations(id)
on delete cascade;

alter table only public.messages
add constraint messages_conversation_id_fkey
foreign key (conversation_id)
references public.conversations(id)
on delete cascade;

alter table only public.messages
add constraint messages_agent_id_fkey
foreign key (agent_id)
references public.agents(id)
on delete set null;

-- Apagar a campanha não apaga o que foi enviado: a mensagem já saiu, o cliente
-- já recebeu, e o histórico da conversa tem de continuar contando essa história
-- mesmo depois que a campanha for descartada.
alter table only public.messages
add constraint messages_campaign_id_fkey
foreign key (campaign_id)
references public.campaigns(id)
on delete set null;

alter table only public.messages
add constraint messages_pkey primary key (id);

alter table only public.messages
add constraint messages_external_id_key unique (external_id);

-- Declared NOT VALID (not inline) to match the deployed state. ~46k legacy
-- messages predate the v1 content schema (no version/kind) and were never
-- checked, so the constraint cannot be validated; it still enforces the shape
-- for every new row. Declaring NOT VALID here keeps `supabase db diff` from
-- re-emitting a drop/re-add on every run. See migration
-- 20260424132025_fix_messages_content_schema_allow_empty.
alter table only public.messages
add constraint messages_content_schema check (
  content = '{}'::jsonb -- status-only upserts (content merged later)
  or (
    content->>'version' is not null
    and content->>'type' in ('text', 'file', 'data')
    and content->>'kind' is not null
  )
) not valid;

create index messages_organization_id_idx
on public.messages
using btree (organization_id);

create index messages_conversation_id_idx
on public.messages
using btree (conversation_id);

create index messages_timestamp_idx
on public.messages
using btree (timestamp);

create index messages_updated_at_idx
on public.messages
using btree (updated_at);

create index messages_org_conv_timestamp_idx
on public.messages
using btree (organization_id, conversation_id, timestamp desc);

-- A garantia de não enviar duas vezes.
--
-- Não há lógica de deduplicação em lugar nenhum: materializar a campanha é um
-- `insert ... on conflict do nothing`, e rodar de novo — porque o operador
-- clicou duas vezes, porque a transação caiu no meio, porque alguém retomou uma
-- campanha pausada — não gera nem uma linha a mais. A idempotência é este
-- índice, e é só isto.
create unique index messages_campaign_recipient_key
on public.messages
using btree (campaign_id, contact_address)
where campaign_id is not null;

-- A fila do disparo e as estatísticas da tela saem daqui.
create index messages_campaign_id_idx
on public.messages
using btree (campaign_id)
where campaign_id is not null;

create trigger handle_new_message
before insert
on public.messages
for each row
execute function public.before_insert_on_messages();

create trigger handle_incoming_message_to_agent
after insert
on public.messages
for each row
when (
  new.direction = 'incoming'::public.direction
  and (new.status ->> 'pending') is not null
)
execute function public.edge_function('/agent-client', 'post');

create trigger handle_mark_as_read_to_dispatcher
after update
on public.messages
for each row
when (
  new.direction = 'incoming'::public.direction
  and new.service <> 'local'::public.service
  and (
    (old.status ->> 'read') <> (new.status ->> 'read')
    or (old.status ->> 'typing') <> (new.status ->> 'typing')
  )
  and (new.status ->> 'pending') is not null
)
execute function public.dispatcher_edge_function();

-- `campaign_id is null` não é detalhe: é o que impede a campanha de furar a
-- fila.
--
-- Este gatilho chama o dispatcher uma vez por linha inserida. Para a mensagem
-- avulsa isso é o certo — sai na hora. Para uma campanha de cinquenta mil, um
-- único `insert ... select` viraria cinquenta mil chamadas de edge function no
-- mesmo instante, o que estoura o teto de mensagens por segundo da Meta,
-- devolve `130429` e derruba a nota de qualidade do número.
--
-- Mensagem de campanha não é despachada na inserção. Ela espera a fila, que
-- entrega no ritmo configurado. - 2026/08/03
create trigger handle_outgoing_message_to_dispatcher
after insert
on public.messages
for each row
when (
  new.direction = 'outgoing'::public.direction
  and new.campaign_id is null
  and new.timestamp <= now()
  and (new.status ->> 'pending') is not null
)
execute function public.dispatcher_edge_function();

-- There are four sources of outgoing messages:
-- 1. history webhook
-- 2. messages echoes webhook (messages sent from WA Business app)
-- 3. UI
-- 4. agent-client
--
-- 1 and 2 do not set status.pending to avoid dispatch.
-- 2 and 3 should pause the conversation.
--
-- Campanha é a quinta origem, e é a única que não deve pausar nada.
--
-- Pausar a conversa existe para não atropelar o humano: se alguém digitou, o
-- agente cala a boca. Disparo em massa não é alguém digitando. Sem esta linha,
-- uma campanha para cinquenta mil contatos pausaria cinquenta mil conversas de
-- uma vez — o agente pararia de responder a base inteira, e ninguém ligaria uma
-- coisa à outra até começarem a chegar reclamações de cliente sem resposta.
-- - 2026/08/03
create trigger pause_conversation_on_human_message
after insert
on public.messages
for each row
when (
  new.direction = 'outgoing'::public.direction
  and new.campaign_id is null
  and new.service <> 'local'::public.service
  and new.timestamp <= now() -- messages not in the future
  and new.timestamp >= now() - interval '10 seconds' -- recent messages
)
execute function public.pause_conversation_on_human_message();

-- O cliente voltou a escrever, e havia um retorno prestes a sair.
--
-- Mesmas guardas de tempo do gatilho acima, e pelo mesmo motivo: a importação
-- de histórico insere entradas antigas em lote, e sem o piso de dez segundos um
-- backfill cancelaria retornos legítimos de conversas que ninguém tocou.
--
-- `local` NÃO está de fora aqui — ao contrário da pausa, que existe para não
-- atropelar um humano que não existe no serviço interno. Isto é regra de
-- produto, e as suítes que rodam em `local` precisam vê-la funcionando.
create trigger cancel_follow_up_on_reply
after insert
on public.messages
for each row
when (
  new.direction = 'incoming'::public.direction
  and new.timestamp <= now()
  and new.timestamp >= now() - interval '10 seconds'
)
execute function public.cancel_follow_up_on_reply();

create trigger handle_message_to_media_preprocessor
after insert
on public.messages
for each row
when (
  (
    new.direction = 'outgoing'::public.direction
    or new.direction = 'incoming'::public.direction
  )
  and (new.status ->> 'pending') is not null
  and (new.content ->> 'type') = 'file'
)
execute function public.edge_function('/media-preprocessor', 'post');

create trigger z_notify_webhook_messages
after insert or update
on public.messages
for each row
execute function public.notify_webhook();

create trigger preserve_direction
before update
on public.messages
for each row
execute function public.preserve_message_direction();

create trigger set_message
before update
on public.messages
for each row
when (
  new.content is not null
)
execute function public.merge_update('content');

create trigger set_status
before update
on public.messages
for each row
when (
  new.status is not null
)
execute function public.merge_update('status');

create trigger set_updated_at
before update
on public.messages
for each row
execute function public.moddatetime('updated_at');
