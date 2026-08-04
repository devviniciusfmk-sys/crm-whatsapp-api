-- Entrega ao cron o lote de mensagens que ele pode despachar nesta rodada, e
-- marca esse lote como reservado.
--
-- Mora em 04_functions_post_tables, e não junto das outras funções em
-- 02_functions, porque `returns setof public.messages` resolve o tipo na hora
-- de criar a função — e 02_functions é aplicado antes de 03_models existir. As
-- vizinhas de lá se safam por só citarem a tabela dentro do corpo.
--
-- O cron antigo fazia `select net.http_post(...) from public.messages where
-- <pendente>`: uma chamada de edge function por linha, sem teto. Enquanto o que
-- sai daqui é conversa, tudo bem — são poucas por minuto. Com campanha deixa de
-- ser: uma lista de cinquenta mil viraria cinquenta mil chamadas num tick,
-- estouraria o limite de mensagens por segundo da Meta, voltaria `130429` e
-- derrubaria a nota de qualidade do número. Que é exatamente o jeito de
-- transformar um disparo em um número queimado.
--
-- Quatro coisas acontecem aqui, e as quatro importam.
--
-- **Teto por número.** O orçamento é por `organization_address` porque é assim
-- que a Meta conta: o limite de mensagens por segundo e a nota de qualidade são
-- do número, não da organização. Dois números da mesma empresa correm em
-- paralelo sem se atrapalhar.
--
-- **Conversa na frente de campanha.** O `order by (campaign_id is not null)` é
-- uma linha só e é a diferença entre um broadcast que atrapalha o atendimento e
-- um que não atrapalha: uma promoção para cinquenta mil pessoas não pode
-- segurar a resposta de quem está falando com a empresa agora. Campanha ocupa o
-- que sobrou do orçamento, nunca o começo dele.
--
-- **`for update skip locked`.** Dois ticks que se sobreponham — porque o
-- anterior demorou, porque alguém rodou na mão — não pegam a mesma linha. Sem
-- isso a mesma mensagem sai duas vezes, e mensagem repetida é a queixa que vira
-- bloqueio.
--
-- **Reserva com validade.** `status.claimed` tira a linha da fila, e a janela
-- de cinco minutos a devolve sozinha se quem pegou morreu no caminho. Mesmo
-- padrão do `annotating` no cron de anotação. O gatilho `set_status` funde o
-- objeto, então gravar `claimed` preserva o `pending` — e é por isso que a
-- condição de elegibilidade continua exigindo `pending`.
--
-- Pausar uma campanha é um `update` numa linha só: a consulta confere o estado
-- da campanha a cada rodada, então nada precisa tocar nas mensagens já
-- materializadas.
--
-- Nota: reservar é um update em `messages`, e update em `messages` é visível
-- para quem tiver webhook de `update` configurado nessa tabela. Quem já recebe
-- webhook de status vai passar a ver mais um evento por mensagem. - 2026/08/03
create function public.claim_pending_messages(
  p_budget_per_address integer default 1200
)
returns setof public.messages
language sql
volatile
security definer
set search_path to ''
as $$
  with eligible as (
    select
      m.id,
      row_number() over (
        partition by m.organization_address
        order by (m.campaign_id is not null), m.timestamp
      ) as position
    from public.messages as m
    left join public.campaigns as c
      on c.id = m.campaign_id
    where m.direction = 'outgoing'::public.direction
      and m.timestamp >= now() - interval '12 hours'
      and m.timestamp <= now() - interval '1 minutes'
      and m.status ->> 'pending' is not null
      and m.status ->> 'held_for_quality_assessment' is null
      and m.status ->> 'accepted' is null
      and m.status ->> 'sent' is null
      and m.status ->> 'delivered' is null
      and m.status ->> 'read' is null
      and m.status ->> 'failed' is null
      and (
        m.status ->> 'claimed' is null
        or (m.status ->> 'claimed')::timestamptz < now() - interval '5 minutes'
      )
      and (
        m.campaign_id is null
        or c.status = 'running'::public.campaign_status
      )
  ),
  locked as (
    select p.id
    from public.messages as p
    where p.id in (
      select e.id
      from eligible as e
      where e.position <= p_budget_per_address
    )
    for update skip locked
  )
  update public.messages as m
  set status = jsonb_build_object('claimed', now())
  from locked as l
  where m.id = l.id
  returning m.*;
$$;
