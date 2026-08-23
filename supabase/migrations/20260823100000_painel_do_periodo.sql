/**
 * # Os números do painel principal, somados no banco
 *
 * Uma chamada, um objeto. A alternativa era o navegador puxar as mensagens do
 * período e somar — e isso funciona no piloto, que tem 460 numa quinzena, e
 * quebra na primeira loja que tem vinte mil. Somar é trabalho de banco.
 *
 * ## O que ele responde, e por que cada um está aqui
 *
 * Pesquisei o que um CRM profissional põe nesta tela, e a lista bate em três
 * coisas, sempre:
 *
 *   DINHEIRO      recebido, em aberto, e — separado — o que já venceu. O dono
 *                 abre o painel por causa disto.
 *   ATENDIMENTO   entraram quantas, foram respondidas quantas, em quanto tempo.
 *                 O tempo até a primeira resposta é citado como o melhor
 *                 indicador antecedente de conversão que existe num canal de
 *                 conversa.
 *   FUNIL         de quantas conversas saiu cobrança, e de quantas cobranças
 *                 saiu dinheiro.
 *
 * E uma quarta, que não é número: QUEM ESTÁ ESPERANDO AGORA. É a única linha
 * desta função que manda alguém trabalhar, e por isso ela não obedece ao
 * período — quem está sem resposta está sem resposta, independentemente de o
 * gráfico em cima mostrar hoje ou o mês.
 *
 * ## Fuso
 *
 * A série diária agrupa pelo fuso da LOJA, e não em UTC. Uma mensagem das 22h
 * de Brasília é do dia seguinte em UTC, e a barra do gráfico apareceria no dia
 * errado por três horas todo dia — o suficiente para a loja concluir que
 * ninguém escreve à noite. - 2026/08/23
 */
create or replace function public.painel_do_periodo(
  p_org uuid,
  p_desde timestamptz,
  p_ate timestamptz default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  _fuso text;
  _ate timestamptz := coalesce(p_ate, now());
  _resultado jsonb;
begin
  /* `security invoker`: a função enxerga o que quem chamou enxerga. Com
   * `definer` ela devolveria os números de qualquer loja a quem soubesse um
   * id — e id de organização circula na URL. */

  select coalesce(o.extra->>'timezone', 'America/Sao_Paulo')
  into _fuso
  from public.organizations o
  where o.id = p_org;

  with
  /* ---------- dinheiro ---------- */
  recebido as (
    select coalesce(sum(r.valor), 0)::bigint as total
    from public.cobranca_recebimentos r
    join public.cobrancas c on c.id = r.cobranca_id
    where c.organization_id = p_org
      and r.recebido_em >= p_desde
      and r.recebido_em < _ate
  ),
  aberto as (
    select
      coalesce(sum(c.valor - coalesce(c.valor_pago, 0)), 0)::bigint as total,
      /* O vencido sai separado porque é outra conversa: em aberto é trabalho
       * futuro, vencido é trabalho atrasado. Somados, o número esconde
       * exatamente a parte que exige ação. */
      coalesce(sum(c.valor - coalesce(c.valor_pago, 0))
        filter (where c.vence_em is not null and c.vence_em < now()), 0)::bigint
        as vencido
    from public.cobrancas c
    where c.organization_id = p_org
      and c.status in ('aberta', 'parcial')
  ),
  /* ---------- atendimento, dia a dia ---------- */
  por_dia as (
    select
      (m.timestamp at time zone _fuso)::date as dia,
      count(*) filter (where m.direction = 'incoming') as entraram,
      count(*) filter (where m.direction = 'outgoing') as sairam
    from public.messages m
    where m.organization_id = p_org
      and m.timestamp >= p_desde
      and m.timestamp < _ate
    group by 1
    order by 1
  ),
  /**
   * ---------- tempo até a primeira resposta ----------
   *
   * Por CONVERSA, e não por mensagem: a definição do setor é "o tempo entre a
   * primeira mensagem do cliente e a primeira resposta humana". Por mensagem,
   * um cliente que manda cinco seguidas viraria cinco medidas, e quem manda
   * cinco seguidas é justamente quem está esperando.
   *
   * Só as conversas cuja primeira entrada caiu no período. Sem isso, uma
   * conversa antiga respondida hoje entraria com um tempo de meses.
   */
  primeira_entrada as (
    select m.conversation_id, min(m.timestamp) as entrou
    from public.messages m
    where m.organization_id = p_org
      and m.direction = 'incoming'
      and m.timestamp >= p_desde
      and m.timestamp < _ate
    group by 1
  ),
  esperas as (
    select extract(epoch from (resposta.respondeu - e.entrou)) / 60 as minutos
    from primeira_entrada e
    cross join lateral (
      select min(o.timestamp) as respondeu
      from public.messages o
      where o.conversation_id = e.conversation_id
        and o.direction = 'outgoing'
        and o.timestamp > e.entrou
    ) resposta
    where resposta.respondeu is not null
  ),
  /* ---------- o funil do dinheiro ---------- */
  conversas as (
    select count(distinct m.conversation_id) as total
    from public.messages m
    where m.organization_id = p_org
      and m.timestamp >= p_desde
      and m.timestamp < _ate
  ),
  cobradas as (
    select
      count(*) as total,
      count(*) filter (where c.paga_em is not null) as pagas
    from public.cobrancas c
    where c.organization_id = p_org
      and c.created_at >= p_desde
      and c.created_at < _ate
  ),
  /**
   * ---------- quem está esperando AGORA ----------
   *
   * Fora do período de propósito. Quem está sem resposta está sem resposta, e
   * o número não pode mudar porque alguém escolheu ver "hoje" em vez do mês.
   *
   * A conta é "a última mensagem da conversa é do cliente". Não é perfeita —
   * uma conversa encerrada com um "obrigado!" dele conta como esperando —, mas
   * o erro é para o lado seguro: pede uma olhada a mais, e não uma a menos.
   */
  esperando as (
    select count(*) as total
    from public.conversations c
    where c.organization_id = p_org
      and c.status <> 'archived'
      and (
        select m.direction
        from public.messages m
        where m.conversation_id = c.id
        order by m.timestamp desc
        limit 1
      ) = 'incoming'
  )
  select jsonb_build_object(
    'recebido', (select total from recebido),
    'em_aberto', (select total from aberto),
    'vencido', (select vencido from aberto),
    'entraram', (select coalesce(sum(entraram), 0) from por_dia),
    'sairam', (select coalesce(sum(sairam), 0) from por_dia),
    'por_dia', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'dia', dia, 'entraram', entraram, 'sairam', sairam
      ) order by dia), '[]'::jsonb)
      from por_dia
    ),
    'resposta_mediana_min', (
      select round(percentile_cont(0.5) within group (order by minutos)::numeric, 1)
      from esperas
    ),
    'respondidas', (select count(*) from esperas),
    'conversas', (select total from conversas),
    'cobrancas', (select total from cobradas),
    'cobrancas_pagas', (select pagas from cobradas),
    'esperando', (select total from esperando)
  )
  into _resultado;

  return _resultado;
end;
$$;

revoke execute on function public.painel_do_periodo(uuid, timestamptz, timestamptz)
from public, anon;

grant execute on function public.painel_do_periodo(uuid, timestamptz, timestamptz)
to authenticated;
