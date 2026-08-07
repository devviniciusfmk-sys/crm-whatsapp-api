-- A nota do prazo dizia que o contato tinha sido avisado, sempre.
--
-- Ela terminava com "O contato foi avisado de que alguém retornaria" mesmo
-- quando nenhuma mensagem saiu — que é o caso de toda organização que não
-- escreveu a mensagem de espera, ou seja, todas hoje. Visto na primeira
-- rodada do cron, em seis conversas de uma vez.
--
-- Uma nota que afirma um envio que não houve é pior que nota nenhuma: quem
-- atende lê, conclui que o cliente já foi tranquilizado e deixa a conversa
-- para depois. O defeito que este prazo existe para consertar, recriado pelo
-- próprio aviso.
--
-- Junto, o tempo em horas quando passa de uma: "há 1247 minutos" é um número
-- que ninguém converte de cabeça no meio do expediente. - 2026/08/07

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

    update public.conversations
    set extra = jsonb_build_object('handoff_escalated', now())
    where id = _conv.id;

    _count := _count + 1;
  end loop;

  return _count;
end;
$$;

revoke execute on function public.escalate_stale_handoffs() from public, anon, authenticated;
