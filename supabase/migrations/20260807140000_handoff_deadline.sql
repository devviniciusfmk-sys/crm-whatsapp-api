-- A transferência ganha prazo.
--
-- Quando o assistente entrega a conversa a uma pessoa, ele se cala por doze
-- horas. Se ninguém pegar — e sábado à tarde numa barbearia ninguém pega — o
-- cliente escreveu, ouviu "vou chamar alguém" e nunca mais recebeu nada.
--
-- Aconteceu numa simulação em 2026/08/07: o cliente insistiu num horário, a
-- assistente transferiu, ele escreveu de novo e levou silêncio. Não é defeito
-- de código: é ausência de prazo. Transferência sem prazo é cliente perdido com
-- aparência de atendimento.
--
-- ## O que este prazo faz, e o que ele não faz
--
-- Faz duas coisas, em ordem de segurança:
--
--   1. Escreve uma nota interna dizendo há quanto tempo a conversa espera. É a
--      linha que a equipe lê no painel, e agora a lista também destaca.
--   2. Manda ao cliente a mensagem que a organização escreveu — SE escreveu.
--
-- Não devolve a conversa ao assistente. Ele já falhou naquela pergunta uma vez;
-- soltá-lo de volta é convidá-lo a inventar a resposta que não sabia.
--
-- ## Sem mensagem escrita, ninguém manda nada
--
-- Mesma régua da mensagem de ausência: uma mensagem que ninguém escreveu é uma
-- mensagem que ninguém quer enviar. O prazo nasce contando e avisando a equipe;
-- falar com o cliente é decisão de quem atende, tomada escrevendo a frase.
--
-- ## Uma vez por transferência
--
-- `handoff_escalated` marca a conversa. Sem isso o cron repetiria a nota a cada
-- cinco minutos e transformaria a fila de espera num despejo de mensagens — o
-- oposto de profissional.

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
    -- O prazo é da organização; quinze minutos é o padrão porque é o que uma
    -- pessoa aceita esperar sem receber nada.
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
        'text', 'Esta conversa espera uma pessoa há ' || _waited ||
          ' minutos e ninguém assumiu. O contato foi avisado de que alguém retornaria.'
      )
    );

    _message := nullif(trim(_conv.org_extra ->> 'handoff_timeout_message'), '');

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

    -- O gatilho de merge cuida do resto do `extra`.
    update public.conversations
    set extra = jsonb_build_object('handoff_escalated', now())
    where id = _conv.id;

    _count := _count + 1;
  end loop;

  return _count;
end;
$$;

revoke execute on function public.escalate_stale_handoffs() from public, anon, authenticated;

-- De cinco em cinco minutos: o prazo mais curto que faz sentido é quinze, e
-- verificar com um terço dessa granularidade mantém o atraso da nota abaixo do
-- que alguém percebe.
--
-- Para desligar:  select cron.unschedule('handoff-deadline');
select
  cron.schedule(
    'handoff-deadline',
    '*/5 * * * *',
    $$ select public.escalate_stale_handoffs() $$
  );
