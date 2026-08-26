/**
 * # Devolver a tela de Contatos: as fichas que a agenda do celular criou
 *
 * Companheira de `20260824030000_ficha_nasce_da_conversa`, que fecha a
 * torneira. Esta enxuga o chão.
 *
 * No pareamento da ponte `whatsapp-web` o WhatsApp entrega todo apelido de
 * perfil que o aparelho conhece, e a regra antiga dava ficha a cada endereço
 * novo. Medido numa base real em 2026/08/24: **1.267 fichas, 1.032 sem uso
 * nenhum** — sem conversa, sem mensagem, sem horário marcado, sem cobrança,
 * sem etiqueta. A tela que serve para achar um cliente tinha virado a agenda
 * telefônica de um celular.
 *
 * ## O que sai, e o que fica
 *
 * Sai a FICHA. Fica o ENDEREÇO, com o apelido de perfil dentro — e ele é quem
 * faz a caixa de entrada escrever "Denise" em vez de 55 53 9101-0987, quem faz
 * a lista de membros de um grupo reconhecer alguém, e quem devolve a ficha
 * pronta no dia em que a pessoa escrever. Nada é perdido de verdade: a ficha
 * volta a nascer sozinha na primeira conversa, com o mesmo nome.
 *
 * ## O gatilho que precisa dormir
 *
 * `contacts_addresses.contact_id` é `on delete set null`, e a ação de
 * integridade dispara `cleanup_unlinked_address_if_empty`, que apaga o endereço
 * quando ele fica solto e sem conversa. Testado no banco local em 2026/08/24:
 * sem desligar o gatilho, apagar a ficha da "Denise" levou junto o endereço e
 * o nome — 0 endereços restantes. Com ele desligado, 1 endereço, nome intacto.
 *
 * Seria a limpeza destruindo exatamente aquilo que ela existe para preservar,
 * e sem avisar.
 *
 * ## Conservadora de propósito
 *
 * Quem falou dentro de um grupo seu TEM mensagem, então tem uso, então fica —
 * mesmo que pela regra nova ele não ganhasse ficha hoje. São 86 nesta base.
 * Apagar de menos se conserta com outra migração; apagar de mais, não.
 *
 * Fichas sem endereço nenhum (23 aqui) também ficam: sem telefone não há como
 * provar que vieram da importação, e podem ter sido criadas à mão. - 2026/08/24
 */

alter table public.contacts_addresses
  disable trigger cleanup_unlinked_address_if_empty;

with usados as (
  select organization_id, contact_address as address
  from public.conversations where contact_address is not null
  union
  select organization_id, contact_address from public.messages
  where contact_address is not null
  union
  select organization_id, contact_address from public.appointments
  where contact_address is not null
  union
  select organization_id, contact_address from public.cobrancas
  where contact_address is not null
  union
  select organization_id, contact_address from public.waitlist
  where contact_address is not null
  union
  select organization_id, contact_address from public.iptv_testes
  where contact_address is not null
)
delete from public.contacts c
where coalesce(array_length(c.tags, 1), 0) = 0
  and (c.extra is null or c.extra = '{}'::jsonb)
  -- Tem endereço: é o que prova que veio da importação, e não da mão de alguém.
  and exists (
    select 1 from public.contacts_addresses ca where ca.contact_id = c.id
  )
  -- E nenhum desses endereços aparece em lugar nenhum que signifique relação.
  and not exists (
    select 1
    from public.contacts_addresses ca
    join usados u
      on u.organization_id = ca.organization_id
     and u.address = ca.address
    where ca.contact_id = c.id
  )
  and not exists (
    select 1 from public.iptv_testes t where t.contact_id = c.id
  );

alter table public.contacts_addresses
  enable trigger cleanup_unlinked_address_if_empty;
