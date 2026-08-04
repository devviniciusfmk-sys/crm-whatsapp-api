-- Uma ficha fantasma por mensagem recebida. Corrige 20260803162535.
--
-- O gatilho `create_contact_on_first_address` é BEFORE INSERT, e o Postgres
-- dispara gatilhos BEFORE INSERT *antes* de descobrir o conflito. O webhook do
-- WhatsApp faz `upsert` em contacts_addresses a cada mensagem que chega, sem
-- `contact_id`. Então, para toda mensagem de alguém já cadastrado:
--
--   1. o gatilho não vê contact_id e cria uma ficha nova com o nome do perfil;
--   2. o Postgres detecta o conflito e manda a linha para o `do update`;
--   3. o endereço continua ligado à ficha antiga;
--   4. a ficha criada no passo 1 fica órfã, sem telefone, para sempre.
--
-- Em produção apareceu como um segundo "Ambern" sem telefone, criado no mesmo
-- microssegundo em que a mensagem chegou — foi assim que se achou.
--
-- A guarda é uma consulta: endereço que já existe não ganha ficha. Endereço
-- novo continua ganhando, que é o motivo do gatilho existir.
--
-- Escrita à mão. `db diff` continua propondo os mesmos 180 `revoke` sobre todas
-- as tabelas e a reescrita de funções que só diferem por CRLF; nada disso tem a
-- ver com esta mudança. - 2026/08/04

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

  if new.extra->'synced' is not null then
    return new;
  end if;

  if exists (
    select 1
    from public.contacts_addresses as existing
    where existing.organization_id = new.organization_id
      and existing.service = new.service
      and existing.address = new.address
  ) then
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

-- Recolhe as fichas que o defeito deixou: sem endereço, sem etiqueta, sem nada
-- preenchido além do nome que veio do perfil, e criadas depois que o gatilho
-- entrou no ar. Uma ficha assim não é de ninguém — quem a abre vê um nome e
-- nenhum jeito de falar com a pessoa.
--
-- As condições são estreitas de propósito: ficha criada à mão pela tela, sem
-- telefone ainda, não é apagada se tiver qualquer outra coisa preenchida, e
-- nada anterior a 2026-08-03 é tocado.
delete from public.contacts as c
where c.created_at >= timestamptz '2026-08-03 16:25:00+00'
  and c.tags = '{}'::text[]
  and (c.extra is null or c.extra = '{}'::jsonb)
  and not exists (
    select 1
    from public.contacts_addresses as a
    where a.contact_id = c.id
  )
  and exists (
    -- Só quando existe outra ficha com o mesmo nome que ficou com o endereço:
    -- é essa a assinatura do fantasma, e é o que separa "sobra do defeito" de
    -- "cadastro que alguém começou e não terminou".
    select 1
    from public.contacts as keeper
    join public.contacts_addresses as a on a.contact_id = keeper.id
    where keeper.organization_id = c.organization_id
      and keeper.id <> c.id
      and keeper.name is not distinct from c.name
  );
