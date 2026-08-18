create table billing.accounts (
  id uuid default gen_random_uuid() not null,
  name text not null,
  organization_id uuid,
  email text,
  -- pix | amplopay | kirvano | kiwify — de onde vem o dinheiro desta conta.
  provider text,
  -- O id do cliente no gateway. É por ele que o postback acha a loja: sem
  -- guardá-lo, chega um pagamento aprovado e não há como saber de quem é.
  external_id text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

alter table only billing.accounts
add constraint accounts_pkey
primary key (id);

alter table only billing.accounts
add constraint accounts_organization_id_fkey
foreign key (organization_id)
references public.organizations(id)
on delete cascade;

-- Um mesmo cliente não existe duas vezes no mesmo gateway: sem isto, um
-- reenvio de postback cria a segunda conta e o pagamento seguinte cai nela.
create unique index accounts_provider_external_idx
on billing.accounts (provider, external_id)
where provider is not null and external_id is not null;

create index accounts_organization_id_idx
on billing.accounts (organization_id);

create trigger set_updated_at
before update
on billing.accounts
for each row
execute function public.moddatetime('updated_at');
