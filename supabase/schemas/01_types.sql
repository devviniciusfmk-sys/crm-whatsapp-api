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
