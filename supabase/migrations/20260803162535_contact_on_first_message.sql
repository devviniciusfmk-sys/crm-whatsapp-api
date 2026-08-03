-- Ficha de contato para quem escreve pela primeira vez.
--
-- Gerada por `supabase db diff` e podada à mão, como o README avisa. O diff
-- trouxe junto um `revoke` de select/insert/update/delete em todas as tabelas
-- e a recriação de funções que só diferem por CRLF — aplicar aqueles revokes
-- tiraria do PostgREST a permissão de ler qualquer tabela e derrubaria o
-- produto. Ficaram a função nova, o gatilho e o preenchimento retroativo.
-- - 2026/08/03
set check_function_bodies = off;

create or replace function public.create_contact_on_first_address()
returns trigger
language plpgsql
set search_path to ''
as $function$
begin
  if new.contact_id is not null then
    return new;
  end if;

  -- O caminho da sincronização tem dono: manage_contact_on_address_sync roda
  -- antes e usa o nome de lá. Duas funções criando ficha para a mesma linha
  -- criariam duas fichas.
  if new.extra->'synced' is not null then
    return new;
  end if;

  insert into public.contacts (organization_id, name)
  values (
    new.organization_id,
    nullif(new.extra->>'name', '')
  )
  returning id into new.contact_id;

  return new;
end;
$function$;

create trigger create_contact_on_first_address
before insert
on public.contacts_addresses
for each row
execute function public.create_contact_on_first_address();

-- Quem já conversou antes de hoje também ganha ficha.
--
-- Sem isto a mudança só valeria para clientes novos, e a tela de Contatos
-- continuaria vazia para quem já atendeu gente — que é o problema que ela
-- resolve. O nome vem do perfil do WhatsApp gravado no endereço; onde não
-- houver, a ficha nasce sem nome e a equipe preenche.
--
-- Endereços do serviço `local` ficam de fora: são conversas de teste do
-- próprio produto, não clientes.
do $$
declare
  _row record;
  _contact_id uuid;
begin
  -- A chave desta tabela é (organization_id, service, address); não há coluna
  -- `id`.
  for _row in
    select organization_id, service, address, extra
    from public.contacts_addresses
    where contact_id is null
      and service <> 'local'::public.service
  loop
    insert into public.contacts (organization_id, name)
    values (_row.organization_id, nullif(_row.extra->>'name', ''))
    returning id into _contact_id;

    update public.contacts_addresses
    set contact_id = _contact_id
    where organization_id = _row.organization_id
      and service = _row.service
      and address = _row.address;
  end loop;
end;
$$;
