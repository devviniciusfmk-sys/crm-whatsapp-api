/**
 * # A ficha passa a nascer da conversa, e não do endereço
 *
 * Até aqui, todo endereço novo em `contacts_addresses` ganhava uma ficha em
 * `contacts` — regra de `create_contact_on_first_address`, criada em
 * 2026/08/03 e correta enquanto o único canal era a API da Meta, onde endereço
 * só aparece porque alguém escreveu para a loja.
 *
 * A ponte `whatsapp-web` separou as duas coisas: no pareamento ela recebe do
 * WhatsApp TODO apelido de perfil que aquele aparelho conhece e manda de uma
 * vez. Medido numa base real em 2026/08/24: **1.267 fichas, 1.055 sem conversa
 * nenhuma**, todas criadas às 23:52 do dia anterior — o minuto do pareamento.
 * A tela de Contatos, que serve para achar um cliente, virou a agenda
 * telefônica de um celular: "_jootaape", "-@ojotaa7d", "'".
 *
 * A regra nova é a que a tela sempre quis dizer:
 *
 *   endereço   nasce de qualquer coisa — é o que pendura mensagem, e ter dez
 *              mil não incomoda ninguém
 *   ficha      nasce de uma CONVERSA privada, ou de alguém salvar de propósito
 *
 * ## O que isso muda, caso a caso
 *
 *   importação do pareamento   endereço com nome de perfil, sem ficha
 *   primeira mensagem privada  conversa criada → ficha criada (igual a antes)
 *   quem fala num grupo seu    sem ficha: conversa de grupo não tem
 *                              `contact_address`, e estar num grupo não é ser
 *                              cliente
 *   agenda do aparelho         inalterado, tem dono próprio
 *                              (`manage_contact_on_address_sync`)
 *   criado à mão / salvo numa  inalterado: a tela insere a ficha ela mesma
 *   lista pela tela
 *
 * ## O ramo novo, e o "Ambern"
 *
 * `before_insert_on_conversations` já criava ficha, mas SÓ quando o endereço
 * ainda não existia. Com a importação, o endereço quase sempre já existe — e
 * sem o ramo novo todo cliente novo ficaria com conversa e sem ficha, que é o
 * bug de 2026/08/18 ("Ambern", dois horários marcados, invisível na lista)
 * multiplicado por todos.
 *
 * Este arquivo NÃO mexe nas 1.055 fichas já criadas. A limpeza é outra
 * migração, porque apagar linha é decisão de quem tem a base. - 2026/08/24
 */

create or replace function public.before_insert_on_conversations() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  _existing record;
  _new_contact uuid;
begin
  -- Validate that external services require either contact_address or group_address
  if new.service <> 'local' and new.contact_address is null and new.group_address is null then
    raise exception 'Conversations with external services require either contact_address or group_address';
  end if;

  /**
   * # A ficha nasce da CONVERSA, e esta função é a única que a cria
   *
   * Conversa de grupo sai na linha de baixo: `contact_address` é nulo por
   * definição nela, e quem fala dentro de um grupo seu não vira cliente por
   * isso. Vira quando alguém salva de propósito, e há tela para isso.
   *
   * ## O que quebrou antes de a regra ser esta
   *
   * Até 2026/08/24 quem criava ficha era `create_contact_on_first_address`, no
   * ENDEREÇO. Fazia sentido enquanto endereço só aparecia porque alguém tinha
   * escrito para a loja, que é o caso da API oficial da Meta. A ponte
   * `whatsapp-web` mudou isso: no pareamento ela recebe do WhatsApp todo
   * apelido de perfil que aquele aparelho conhece e manda tudo de uma vez.
   *
   * Medido numa base real em 2026/08/24: **1.267 fichas, 1.055 sem conversa
   * nenhuma**, todas criadas às 23:52 do dia anterior — o minuto do
   * pareamento. A tela de Contatos, que serve para achar um cliente, tinha
   * virado a agenda telefônica de um celular, com "_jootaape" dentro.
   *
   * Endereço continua nascendo de qualquer coisa: é ele que pendura mensagem,
   * e ter dez mil não incomoda ninguém. Ficha é uma pessoa com quem a loja tem
   * relação, e agora ela custa uma conversa. - 2026/08/24
   */
  if new.contact_address is null then
    return new;
  end if;

  select ca.address, ca.contact_id, nullif(ca.extra->>'name', '') as nome
  into _existing
  from public.contacts_addresses ca
  where ca.organization_id = new.organization_id
    and ca.service = new.service
    and ca.address = new.contact_address
  order by ca.created_at desc
  limit 1;

  if _existing.address is null then
    /**
     * A ficha nasce JUNTO com o endereço, e não depois.
     *
     * Este gatilho criava o endereço sem `contact_id`, contando com
     * `create_contact_on_first_address` para dar a ficha na primeira mensagem.
     * Só que aquela função pulava quando o endereço JÁ EXISTIA — proteção
     * contra ficha fantasma a cada `upsert` do webhook — e o endereço já
     * existia, porque foi este gatilho que o criou. Resultado: endereço com
     * conversa, com nome de perfil, e ficha nenhuma.
     *
     * Quem caía nesse buraco desaparecia da tela de Contatos, que lê
     * `public.contacts`. Encontrado em 2026/08/18 numa base real: o cliente
     * "Ambern", com dois horários marcados, não existia na lista.
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

  elsif _existing.contact_id is null then
    /**
     * O endereço já existe e está SEM ficha: é agora que ela nasce.
     *
     * Este virou o caminho COMUM, e não a exceção. O webhook grava o endereço
     * com o apelido de perfil antes de a mensagem virar conversa; a importação
     * inteira para aqui sem ficha nenhuma, e só quem conversa de verdade chega
     * nesta linha.
     *
     * Sem este ramo, o "Ambern" de 2026/08/18 voltaria multiplicado: todo
     * cliente novo ficaria com endereço, com conversa e sem ficha.
     *
     * O nome vem do endereço, que é onde o apelido de perfil está guardado.
     */
    insert into public.contacts (organization_id, name)
    values (new.organization_id, _existing.nome)
    returning id into _new_contact;

    update public.contacts_addresses
    set contact_id = _new_contact
    where organization_id = new.organization_id
      and service = new.service
      and address = new.contact_address
      and contact_id is null;
  end if;

  return new;
end;
$$;

-- A função que dava ficha a todo endereço novo. O gatilho sai primeiro: um
-- `drop function` com gatilho dependente falharia, e falhar no meio de uma
-- migração é como se ganha um banco em dois estados.
drop trigger if exists create_contact_on_first_address
  on public.contacts_addresses;

drop function if exists public.create_contact_on_first_address();
