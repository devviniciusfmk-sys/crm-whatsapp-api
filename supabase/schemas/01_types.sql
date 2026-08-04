create type public.direction as enum ('incoming', 'outgoing', 'internal');

create type public.service as enum (
  'whatsapp',
  'instagram',
  'local',
  'slack',
  'discord',
  'teams',
  'whatsapp-web'
);

create type public.webhook_operation as enum ('insert', 'update');

create type public.webhook_table as enum (
  'messages',
  'conversations',
  'organizations_addresses',
  'contacts',
  'contacts_addresses',
  'logs'
);

create type public.role as enum ('owner', 'admin', 'member');

-- Estados de um compromisso. "no_show" é separado de "cancelled" de propósito:
-- quem avisou que não vem e quem simplesmente não apareceu são clientes
-- diferentes, e é a segunda coluna que vira decisão de negócio.
create type public.appointment_status as enum (
  'scheduled',
  'done',
  'cancelled',
  'no_show'
);

-- Estados de uma campanha.
--
-- "paused" existe para que parar um disparo em andamento seja um `update` numa
-- linha só: a fila consulta o estado da campanha a cada rodada, então pausar
-- não precisa tocar nas dezenas de milhares de mensagens já materializadas.
-- Sem isso, "parar" viraria um update em massa na tabela de mensagens no exato
-- momento em que ninguém quer uma transação longa ali.
--
-- "completed" é derivado (não sobrou pendente) e "canceled" é decisão de quem
-- opera. Os dois param a fila do mesmo jeito, mas só o segundo é resposta a
-- alguma coisa ter dado errado — e essa é a primeira pergunta de quem abre a
-- tela depois. - 2026/08/03
create type public.campaign_status as enum (
  'draft',
  'scheduled',
  'running',
  'paused',
  'completed',
  'canceled'
);
