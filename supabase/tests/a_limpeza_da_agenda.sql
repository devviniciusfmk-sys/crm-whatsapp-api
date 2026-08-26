-- # O que a limpeza apaga, e o que ela tem de deixar em pé
--
-- Roda contra o banco LOCAL, em transacao com rollback.
--
--   deno task test:limpeza
--
-- O caso que importa e o ENDERECO: `on delete set null` acorda
-- `cleanup_unlinked_address_if_empty`, e sem desligar o gatilho a limpeza
-- apaga o apelido de perfil que ela existe para preservar.

\set ON_ERROR_STOP on
begin;

create temp table resultado(caso text, achado text, ok boolean);

insert into public.organizations (name) values ('Teste da limpeza') returning id \gset org_
insert into public.organizations_addresses (organization_id, service, address)
values (:'org_id', 'whatsapp-web', '5511999999999');

-- (a) da importacao: ficha com endereco, sem uso nenhum
insert into public.contacts (organization_id, name) values (:'org_id', 'Denise') returning id \gset importada_
insert into public.contacts_addresses (organization_id, service, address, contact_id, extra)
values (:'org_id','whatsapp-web','5511900000001', :'importada_id', '{"name":"Denise"}');

-- (b) quem conversou
insert into public.contacts (organization_id, name) values (:'org_id', 'Cliente') returning id \gset cliente_
insert into public.contacts_addresses (organization_id, service, address, contact_id)
values (:'org_id','whatsapp-web','5511900000002', :'cliente_id');
insert into public.conversations (organization_id, organization_address, service, contact_address)
values (:'org_id','5511999999999','whatsapp-web','5511900000002');

-- (c) quem falou num grupo: tem mensagem, entao fica
insert into public.contacts (organization_id, name) values (:'org_id', 'Do grupo') returning id \gset grupo_
insert into public.contacts_addresses (organization_id, service, address, contact_id)
values (:'org_id','whatsapp-web','5511900000003', :'grupo_id');
insert into public.conversations (organization_id, organization_address, service, group_address)
values (:'org_id','5511999999999','whatsapp-web','120363000000000001@g.us') returning id \gset conversa_
insert into public.messages (organization_id, organization_address, service, conversation_id, direction, contact_address, group_address, content)
values (:'org_id','5511999999999','whatsapp-web', :'conversa_id', 'incoming', '5511900000003', '120363000000000001@g.us', '{"version":"1","type":"text","kind":"text","text":"oi"}');

-- (d) etiquetada a mao, sem uso: etiqueta e trabalho de alguem
insert into public.contacts (organization_id, name, tags) values (:'org_id', 'Etiquetada', array['vip']) returning id \gset vip_
insert into public.contacts_addresses (organization_id, service, address, contact_id)
values (:'org_id','whatsapp-web','5511900000004', :'vip_id');

alter table public.contacts_addresses disable trigger cleanup_unlinked_address_if_empty;

with usados as (
  select organization_id, contact_address as address from public.conversations where contact_address is not null
  union select organization_id, contact_address from public.messages where contact_address is not null
  union select organization_id, contact_address from public.appointments where contact_address is not null
  union select organization_id, contact_address from public.cobrancas where contact_address is not null
  union select organization_id, contact_address from public.waitlist where contact_address is not null
  union select organization_id, contact_address from public.iptv_testes where contact_address is not null
)
delete from public.contacts c
where coalesce(array_length(c.tags, 1), 0) = 0
  and (c.extra is null or c.extra = '{}'::jsonb)
  and exists (select 1 from public.contacts_addresses ca where ca.contact_id = c.id)
  and not exists (
    select 1 from public.contacts_addresses ca
    join usados u on u.organization_id = ca.organization_id and u.address = ca.address
    where ca.contact_id = c.id
  )
  and not exists (select 1 from public.iptv_testes t where t.contact_id = c.id);

alter table public.contacts_addresses enable trigger cleanup_unlinked_address_if_empty;

insert into resultado select 'a ficha da importacao sai',
  count(*) || ' ficha(s)', count(*) = 0 from public.contacts where id = :'importada_id';

insert into resultado select 'mas o ENDERECO dela fica, com o apelido',
  count(*) || ' / ' || coalesce(min(extra->>'name'),'sem nome'),
  count(*) = 1 and min(extra->>'name') = 'Denise'
  from public.contacts_addresses where organization_id = :'org_id' and address = '5511900000001';

insert into resultado select 'quem conversou fica',
  count(*) || ' ficha(s)', count(*) = 1 from public.contacts where id = :'cliente_id';

insert into resultado select 'quem falou em grupo fica (tem mensagem)',
  count(*) || ' ficha(s)', count(*) = 1 from public.contacts where id = :'grupo_id';

insert into resultado select 'quem foi etiquetado a mao fica',
  count(*) || ' ficha(s)', count(*) = 1 from public.contacts where id = :'vip_id';

insert into resultado select 'nenhum endereco foi apagado',
  count(*) || ' de 4', count(*) = 4 from public.contacts_addresses where organization_id = :'org_id';

\pset format unaligned
\pset tuples_only on
select case when ok then '  ok    ' else '  FALHA ' end || caso ||
       case when ok then '' else '  -> achado ' || achado end from resultado order by caso;
select '';
select count(*) filter (where ok) || ' ok, ' || count(*) filter (where not ok) || ' falha(s)' from resultado;

rollback;
