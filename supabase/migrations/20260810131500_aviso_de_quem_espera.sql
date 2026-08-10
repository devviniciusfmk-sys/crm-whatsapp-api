-- O aviso de 15 minutos passa a puxar alguém no aparelho, e não só na tela.
--
-- Escrita à mão: `db diff` não distingue esta mudança do resto do esquema e
-- emitiria os 168 `revoke` de sempre junto. Corpo idêntico ao arquivo
-- declarativo, com o `net.http_post` novo no meio do laço.

-- O prazo da transferência: quem espera demais volta para o assistente.
--
-- Nasceu como migração à mão em 2026/08/07 e nunca entrou no esquema
-- declarativo — então o primeiro `db diff` depois disso quis APAGÁ-LA, por
-- não a encontrar entre os arquivos. Um esquema que não descreve o banco
-- transforma cada migração seguinte numa armadilha. - 2026/08/09
create or replace function public.escalate_stale_handoffs()
returns integer
language plpgsql
security definer
set search_path to ''
as $$
declare
  _conv record;
  _minutes integer;
  _message text;
  _waited integer;
  _waited_label text;
  _count integer := 0;
begin
  for _conv in
    select
      c.id,
      c.organization_id,
      c.service,
      c.organization_address,
      c.contact_address,
      c.extra,
      o.extra as org_extra
    from public.conversations c
    join public.organizations o on o.id = c.organization_id
    where c.extra -> 'handoff' is not null
      and c.extra ->> 'handoff_escalated' is null
  loop
    _minutes := coalesce(
      (_conv.org_extra ->> 'handoff_timeout_minutes')::integer,
      15
    );

    _waited := floor(
      extract(epoch from (now() - (_conv.extra -> 'handoff' ->> 'at')::timestamptz)) / 60
    );

    if _waited < _minutes then
      continue;
    end if;

    _waited_label := case
      when _waited < 60 then _waited || ' minutos'
      when _waited < 60 * 24 then floor(_waited / 60) || ' horas'
      else floor(_waited / (60 * 24)) || ' dias'
    end;

    _message := nullif(trim(_conv.org_extra ->> 'handoff_timeout_message'), '');

    insert into public.messages (
      organization_id, conversation_id, service,
      organization_address, contact_address, direction, content
    )
    values (
      _conv.organization_id, _conv.id, _conv.service,
      _conv.organization_address, _conv.contact_address, 'internal',
      jsonb_build_object(
        'version', '1',
        'type', 'text',
        'kind', 'text',
        'text', 'Esta conversa espera uma pessoa há ' || _waited_label ||
          ' e ninguém assumiu. ' ||
          case
            when _message is not null
              then 'O contato recebeu a mensagem de espera.'
            else 'O contato não recebeu nada: não há mensagem de espera escrita nas configurações.'
          end
      )
    );

    if _message is not null then
      insert into public.messages (
        organization_id, conversation_id, service,
        organization_address, contact_address, direction, content
      )
      values (
        _conv.organization_id, _conv.id, _conv.service,
        _conv.organization_address, _conv.contact_address, 'outgoing',
        jsonb_build_object(
          'version', '1',
          'type', 'text',
          'kind', 'text',
          'text', _message
        )
      );
    end if;

    /**
     * E puxa alguém no aparelho, não só na tela.
     *
     * A nota interna acima e a mensagem de espera resolvem metade: a conversa
     * fica marcada e o contato ouve alguma coisa. A outra metade é que ninguém
     * da casa fica sabendo — e é justamente por ninguém ter olhado que ela
     * chegou aos quinze minutos. Um aviso que só aparece na tela de quem já
     * não está olhando é um aviso que chega no dia seguinte. - 2026/08/10
     */
    perform net.http_post(
      url := (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'edge_functions_url'
      ) || '/avisar',
      headers := jsonb_build_object(
        'content-type', 'application/json',
        'authorization', 'Bearer ' || (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'edge_functions_token'
        )
      ),
      body := jsonb_build_object(
        'organization_id', _conv.organization_id,
        'conversation_id', _conv.id,
        'motivo', 'stale'
      ),
      timeout_milliseconds := 10000
    );

    update public.conversations
    set extra = jsonb_build_object('handoff_escalated', now())
    where id = _conv.id;

    _count := _count + 1;
  end loop;

  return _count;
end;
$$;

revoke execute on function public.escalate_stale_handoffs() from public, anon, authenticated;

