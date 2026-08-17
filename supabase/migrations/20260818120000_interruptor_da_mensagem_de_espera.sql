-- Um interruptor para a mensagem de espera, sem apagar o texto.
--
-- Desligar era apagar a frase, e quem apagava perdia o que tinha escrito. A
-- barbearia perguntou onde estava o botão de desligar, e a resposta honesta
-- era que não existia.
--
-- `_off` ausente é LIGADA, de propósito: toda loja que já tem frase escrita
-- continua mandando, sem migração de dados e sem ninguém precisar entrar na
-- tela para reativar o que nunca desativou.
--
-- A nota interna passa a distinguir três casos. "Não escreveram" e
-- "escreveram e desligaram" levam a caminhos diferentes em Configurações, e
-- dizer "não há mensagem escrita" a quem tem uma escrita manda a pessoa
-- reescrever o que já está lá. - 2026/08/18

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
  _desligada boolean;
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

    -- O interruptor da tela vale mais que o texto escrito. `_off` AUSENTE é
    -- ligada, para que nenhuma loja que já tem frase escrita pare de mandar
    -- por causa desta linha. - 2026/08/18
    _desligada := coalesce(
      (_conv.org_extra ->> 'handoff_timeout_message_off')::boolean, false
    );

    _message := case
      when _desligada then null
      else nullif(trim(_conv.org_extra ->> 'handoff_timeout_message'), '')
    end;

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
          -- Três casos, e não dois: "não escreveram" e "escreveram e
          -- desligaram" levam a caminhos diferentes em Configurações, e a nota
          -- que diz "não há mensagem escrita" para quem tem uma escrita manda
          -- a pessoa reescrever o que já está lá. - 2026/08/18
          case
            when _message is not null
              then 'O contato recebeu a mensagem de espera.'
            when _desligada
              then 'O contato não recebeu nada: a mensagem de espera está desligada nas configurações.'
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

