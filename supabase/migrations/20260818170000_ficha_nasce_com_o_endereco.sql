-- Quem escreve ganha ficha, sempre — e quem já ficou sem, ganha agora.
--
-- `before_insert_on_conversations` criava o endereço sem `contact_id`,
-- contando com `create_contact_on_first_address` para dar a ficha na primeira
-- mensagem. Aquela função pula quando o endereço JÁ EXISTE — proteção contra
-- ficha fantasma a cada upsert do webhook — e o endereço já existia, porque
-- foi este gatilho que o criou.
--
-- Quem cai nesse buraco desaparece da tela de Contatos, que lê
-- `public.contacts`. Encontrado numa base real em 2026/08/18: o cliente
-- "Ambern", com dois horários marcados, não existia na lista.
--
-- A segunda parte repara o que já aconteceu: endereço com conversa e sem
-- ficha ganha uma, com o nome do perfil quando ele existe.

create or replace function public.before_insert_on_conversations() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  _existing_address text;
  _new_contact uuid;
begin
  -- Validate that external services require either contact_address or group_address
  if new.service <> 'local' and new.contact_address is null and new.group_address is null then
    raise exception 'Conversations with external services require either contact_address or group_address';
  end if;

  if new.contact_address is null then
    return new;
  end if;

  select address into _existing_address
  from public.contacts_addresses
  where organization_id = new.organization_id
    and service = new.service
    and address = new.contact_address
  order by created_at desc
  limit 1;

  if _existing_address is null then
    /**
     * A ficha nasce JUNTO com o endereço, e não depois.
     *
     * Este gatilho criava o endereço sem `contact_id`, contando com
     * `create_contact_on_first_address` para dar a ficha na primeira mensagem.
     * Só que aquela função pula quando o endereço JÁ EXISTE — proteção contra
     * ficha fantasma a cada `upsert` do webhook — e o endereço já existia,
     * porque foi este gatilho que o criou. Resultado: endereço com conversa,
     * com nome de perfil, e ficha nenhuma.
     *
     * Quem cai nesse buraco desaparece da tela de Contatos, que lê
     * `public.contacts`. Encontrado em 2026/08/18 numa base real: o cliente
     * "Ambern", com dois horários marcados, não existia na lista.
     *
     * Criando a ficha aqui, `create_contact_on_first_address` vê o
     * `contact_id` preenchido e sai na primeira linha — não há ficha dupla.
     */
    insert into public.contacts (organization_id)
    values (new.organization_id)
    returning id into _new_contact;

    insert into public.contacts_addresses (
      organization_id,
      address,
      service,
      contact_id
    ) values (
      new.organization_id,
      new.contact_address,
      new.service,
      _new_contact
    );
  end if;

  return new;
end;
$$;


-- O reparo: uma ficha para cada endereço que ficou sem.
--
-- Em laço, e não numa única instrução com `returning`. A versão em CTE casava
-- ficha nova com endereço por numeração de linha, com ordenações diferentes dos
-- dois lados — duas fichas criadas na mesma organização podiam trocar de dono,
-- e o erro seria invisível: dois clientes com o nome do outro.
--
-- Uma linha por vez é mais lenta e não tem como errar o par. São dezenas de
-- linhas, uma vez na vida.
do $$
declare
  _orfao record;
  _ficha uuid;
begin
  for _orfao in
    select organization_id, service, address, extra ->> 'name' as nome
    from public.contacts_addresses
    where contact_id is null
  loop
    insert into public.contacts (organization_id, name)
    values (_orfao.organization_id, nullif(_orfao.nome, ''))
    returning id into _ficha;

    update public.contacts_addresses
    set contact_id = _ficha
    where organization_id = _orfao.organization_id
      and service = _orfao.service
      and address = _orfao.address
      and contact_id is null;
  end loop;
end;
$$;
