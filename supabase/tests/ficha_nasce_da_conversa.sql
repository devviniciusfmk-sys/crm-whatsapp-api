-- # Quando uma ficha nasce, e quando ela NAO nasce
--
-- Roda contra o banco LOCAL (npx supabase start), dentro de uma transacao que
-- termina em rollback: nao deixa nada para tras.
--
--   deno task test:ficha
--
-- Conferido em 2026/08/24: 3 ok e 4 falhas ANTES da migracao
-- 20260824030000_ficha_nasce_da_conversa, 7 ok depois. Um teste que passa dos
-- dois lados nao esta medindo a mudanca.

\set ON_ERROR_STOP on
begin;

create temp table resultado(caso text, esperado text, achado text, ok boolean);

insert into public.organizations (name) values ('Teste da ficha')
returning id \gset org_

insert into public.organizations_addresses (organization_id, service, address)
values (:'org_id', 'whatsapp-web', '5511999999999');

-- A) importação do pareamento: endereço com apelido de perfil, sem conversa
insert into public.contacts_addresses (organization_id, service, address, extra)
values (:'org_id', 'whatsapp-web', '5511900000001', '{"name":"_jootaape"}');

insert into resultado
select 'A) importacao nao cria ficha', '0 fichas',
       count(*) || ' fichas', count(*) = 0
from public.contacts where organization_id = :'org_id';

-- B) a mesma pessoa conversa no privado: agora vira ficha, com o nome do perfil
insert into public.conversations (organization_id, organization_address, service, contact_address)
values (:'org_id', '5511999999999', 'whatsapp-web', '5511900000001');

insert into resultado
select 'B) conversa privada cria a ficha', '1 ficha chamada _jootaape',
       count(*) || ' / ' || coalesce(min(name), 'sem nome'),
       count(*) = 1 and min(name) = '_jootaape'
from public.contacts where organization_id = :'org_id';

insert into resultado
select 'B2) e o endereco fica ligado nela', 'ligado',
       coalesce(contact_id::text, 'solto'), contact_id is not null
from public.contacts_addresses
where organization_id = :'org_id' and address = '5511900000001';

-- C) quem fala num grupo: conversa de grupo não tem contact_address
insert into public.contacts_addresses (organization_id, service, address, extra)
values (:'org_id', 'whatsapp-web', '5511900000002', '{"name":"Alguem do grupo"}');

insert into public.conversations (organization_id, organization_address, service, group_address)
values (:'org_id', '5511999999999', 'whatsapp-web', '120363000000000000@g.us');

insert into resultado
select 'C) membro de grupo nao vira ficha', 'ainda 1 ficha',
       count(*) || ' fichas', count(*) = 1
from public.contacts where organization_id = :'org_id';

-- D) cliente novo cujo endereço ainda não existe
insert into public.conversations (organization_id, organization_address, service, contact_address)
values (:'org_id', '5511999999999', 'whatsapp-web', '5511900000003');

insert into resultado
select 'D) cliente novo sem endereco previo ganha ficha', '2 fichas',
       count(*) || ' fichas', count(*) = 2
from public.contacts where organization_id = :'org_id';

insert into resultado
select 'D2) e o endereco dele nasce ligado', '1 ligado',
       count(*) filter (where contact_id is not null) || ' ligado',
       count(*) filter (where contact_id is not null) = 1
from public.contacts_addresses
where organization_id = :'org_id' and address = '5511900000003';

-- E) segunda conversa da mesma pessoa não duplica ficha
insert into public.conversations (organization_id, organization_address, service, contact_address)
values (:'org_id', '5511999999999', 'whatsapp-web', '5511900000001');

insert into resultado
select 'E) segunda conversa nao duplica a ficha', '2 fichas',
       count(*) || ' fichas', count(*) = 2
from public.contacts where organization_id = :'org_id';

\pset format unaligned
\pset tuples_only on

select case when ok then '  ok    ' else '  FALHA ' end || caso ||
       case when ok then '' else '  -> esperado ' || esperado || ', achado ' || achado end
from resultado order by caso;

select '';
select count(*) filter (where ok) || ' ok, ' || count(*) filter (where not ok) || ' falha(s)'
from resultado;

rollback;
