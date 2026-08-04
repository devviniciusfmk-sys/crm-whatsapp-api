create table public.contacts (
  organization_id uuid not null,
  id uuid default gen_random_uuid() not null,
  name text,
  -- Etiquetas de atendimento: "vip", "sumido", "veio do Instagram".
  --
  -- É a continuação das etiquetas que a pessoa já usa no WhatsApp Business, e
  -- é assim que qualquer ferramenta séria segmenta um disparo — por etiqueta e
  -- atributo, não por cidade ou por ter e-mail preenchido. Quem abre a tela
  -- pensa "mandar para os VIP", não "mandar para quem tem e-mail em Pelotas".
  --
  -- Array e não tabela de junção: são poucas etiquetas por contato (a
  -- recomendação que circula é não passar de cinco), e `&&` e `@>` respondem
  -- as duas perguntas que importam — "tem alguma destas" e "tem todas estas" —
  -- sem join nenhum. Uma tabela de junção pagaria normalização por um problema
  -- que não existe neste tamanho.
  --
  -- Texto livre, sem catálogo: obrigar a cadastrar a etiqueta antes de usá-la
  -- é o passo em que se desiste de etiquetar. A lista de etiquetas existentes
  -- sai da própria coluna. - 2026/08/04
  tags text[] default '{}'::text[] not null,
  extra jsonb,
  status text default 'active'::text not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

alter table only public.contacts
add constraint contacts_pkey
primary key (id);

alter table only public.contacts
add constraint contacts_organization_id_fkey
foreign key (organization_id)
references public.organizations(id)
on delete cascade;

create index contacts_organization_id_idx
on public.contacts
using btree (organization_id);

-- GIN porque a pergunta do disparo é sempre de contenção ("tem alguma destas
-- etiquetas"), e é o único tipo de índice que responde isso sem varrer a
-- tabela. Sem ele, montar o público de uma base grande lê todos os contatos.
create index contacts_tags_idx
on public.contacts
using gin (tags);

create trigger set_extra
before update
on public.contacts
for each row
when (
  new.extra is not null
)
execute function public.merge_update('extra');

create trigger set_updated_at
before update
on public.contacts
for each row
execute function public.moddatetime('updated_at');

create trigger z_notify_webhook_contacts
after insert or update
on public.contacts
for each row
execute function public.notify_webhook();


