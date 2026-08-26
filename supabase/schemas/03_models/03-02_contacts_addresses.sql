-- FRONTEND NOTE: PostgreSQL checks INSERT policy BEFORE conflict detection.
-- Upsert with synced.action='add' in payload fails even if row exists.
-- Use .upsert() for linking, .update() for unlinking.

create table public.contacts_addresses (
  organization_id uuid not null,
  contact_id uuid,
  service public.service not null,
  address text not null,
  extra jsonb,
  status text default 'active'::text not null,
  -- Quando esta pessoa pediu para não receber mais campanha de marketing.
  --
  -- Coluna, e não uma chave no `extra`, contrariando o padrão da casa de
  -- propósito. Três razões, e as três são a mesma: isto não é metadado.
  --
  -- É consentimento, e a LGPD trata a retirada dele como obrigação — precisa
  -- aparecer num `select` sem ninguém saber onde procurar dentro de um JSON.
  -- Precisa ser indexável, porque entra no `where` de toda materialização de
  -- público. E não pode depender de um merge de JSON dar certo: `extra` passa
  -- pelo gatilho `merge_update`, e o dia em que um merge se perder o cliente
  -- volta a receber promoção depois de ter pedido para sair.
  --
  -- `status = 'inactive'` não serve: endereço inativo é outra coisa (número que
  -- não existe mais). Quem pediu para sair da lista continua sendo cliente e
  -- continua recebendo utility — confirmação de horário, aviso de entrega.
  -- Só marketing para. - 2026/08/03
  marketing_opt_out_at timestamp with time zone,
  -- Quando esta pessoa pediu para RECEBER campanha, e por onde ela pediu.
  --
  -- O par do descadastro acima, e coluna pelas mesmas três razões: não é
  -- metadado, entra no `where` de toda materialização de público, e não pode
  -- depender de um merge de JSON dar certo.
  --
  -- Existe porque a regra da casa estava mais dura que a da Meta sem precisar
  -- ser: o público exigia CONVERSA prévia, e a Meta exige consentimento. Quem
  -- preencheu formulário, marcou a caixa ou mandou "quero" em outro canal
  -- pediu para receber, e ficava de fora por nunca ter escrito neste número.
  --
  -- A origem é obrigatória — a restrição está logo abaixo —, e é o ponto
  -- inteiro. Sem ela, "opt-in registrado" vira um campo que alguém preenche em
  -- massa para destravar o disparo: a mesma lista fria de antes com outro nome,
  -- e o preço aparecendo na nota de qualidade três semanas depois, quando
  -- ninguém mais liga uma coisa à outra. Guardar de onde veio é o que responde
  -- à pergunta da LGPD — "prove que ele consentiu" — e à do operador: "por que
  -- este número está na lista?". - 2026/08/23
  marketing_opt_in_at timestamp with time zone,
  marketing_opt_in_origem text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

-- service is part of the PK: the same canonical address (e.g. bare phone
-- digits shared by 'whatsapp' and 'whatsapp-web') is a separate row per
-- service. Cross-service identity lives at the contacts level via contact_id.
alter table only public.contacts_addresses
add constraint contacts_addresses_pkey
primary key (organization_id, service, address);

alter table only public.contacts_addresses
add constraint contacts_addresses_organization_id_fkey
foreign key (organization_id)
references public.organizations(id)
on delete cascade;

alter table only public.contacts_addresses
add constraint contacts_addresses_contact_id_fkey
foreign key (contact_id)
references public.contacts(id)
on delete set null;

-- Opt-in sem origem é recusado pelo banco, e não por educação da tela.
-- Uma regra de consentimento que mora só no formulário dura até o primeiro
-- import de planilha.
alter table only public.contacts_addresses
add constraint contacts_addresses_opt_in_tem_origem
check (
  marketing_opt_in_at is null
  or nullif(btrim(marketing_opt_in_origem), '') is not null
);

create index contacts_addresses_contact_id_idx
on public.contacts_addresses using btree (contact_id);

-- O `where` da campanha passa por aqui em toda prévia e todo disparo. Parcial
-- porque quem tem opt-in registrado é a minoria: o índice paga por linha viva.
create index contacts_addresses_opt_in_idx
on public.contacts_addresses
using btree (organization_id, service)
where marketing_opt_in_at is not null;

create trigger set_extra
before update
on public.contacts_addresses
for each row
when (
  new.extra is not null
)
execute function public.merge_update('extra');

create trigger set_updated_at
before update
on public.contacts_addresses
for each row
execute function public.moddatetime('updated_at');

create trigger z_notify_webhook_contacts_addresses
after insert or update
on public.contacts_addresses
for each row
execute function public.notify_webhook();

create trigger manage_contact_on_address_sync -- Should execute before merge_update
before insert or update
on public.contacts_addresses
for each row
when (
  new.extra->'synced' is not null -- Performance optimization
)
execute function public.manage_contact_on_address_sync();

-- Aqui morava `create_contact_on_first_address`, que dava ficha a TODO endereço
-- novo. A ponte `whatsapp-web` transformou isso numa enxurrada: no pareamento
-- ela manda todo apelido de perfil que o aparelho conhece, e numa base real de
-- 2026/08/24 isso virou 1.055 fichas sem conversa nenhuma, criadas no mesmo
-- minuto. Quem cria ficha agora é `before_insert_on_conversations` — a regra
-- passou a ser "ficha é gente com quem se conversou". - 2026/08/24

create trigger cleanup_orphaned_contact_on_sync
after update
on public.contacts_addresses
for each row
when (
  old.contact_id is not null
  and new.contact_id is null
  and new.extra->'synced'->>'action' = 'remove'
)
execute function public.cleanup_orphaned_contact_on_sync();

create trigger cleanup_unlinked_address_if_empty
after update
on public.contacts_addresses
for each row
when (
  old.contact_id is not null
  and new.contact_id is null
  and new.extra->'synced'->>'action' is distinct from 'add' -- Ignore active synced addresses
)
execute function public.cleanup_unlinked_address_if_empty();

-- Supports the BSUID bridge lookup and phone-based search, mirroring the
-- organizations_addresses phone_number index.
create index contacts_addresses_phone_number_idx
on public.contacts_addresses
using btree ((extra->>'phone_number'))
where service = 'whatsapp';

-- Lookup by BSUID (e.g. the user_id_update handler matching extra.bsuid).
create index contacts_addresses_bsuid_idx
on public.contacts_addresses
using btree ((extra->>'bsuid'))
where service = 'whatsapp';

-- Lookup by the replaced_by_bsuid trail when linking a new address back to the
-- old contact after a BSUID change.
create index contacts_addresses_replaced_by_bsuid_idx
on public.contacts_addresses
using btree ((extra->>'replaced_by_bsuid'))
where service = 'whatsapp';
