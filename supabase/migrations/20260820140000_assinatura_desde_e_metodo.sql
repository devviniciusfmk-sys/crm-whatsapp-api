-- Quando contratou, como paga e de quantos em quantos dias renova.
--
-- A ficha do assinante dizia "venceu em 05/08" e mais nada sobre o contrato:
-- nem desde quando a pessoa assina, nem se o dinheiro entra sozinho pelo link
-- ou se alguém tem de ir atrás. As duas mudam o que se faz com um atraso.
--
-- Tudo já estava em `cobrancas` (`paga_em`, `metodo`, `validade_dias`); só não
-- subia até a visão. Três colunas no FIM, que é o que `create or replace view`
-- aceita sem 42P16.
create or replace view public.contact_overview
with (security_invoker = on) as
with enderecos as (
  select
    ca.contact_id,
    ca.organization_id,
    ca.address,
    ca.service
  from public.contacts_addresses ca
  where ca.contact_id is not null
),

-- Quantas conversas e quando foi a última coisa dita, nos dois sentidos.
falas as (
  select
    e.contact_id,
    count(distinct m.conversation_id) as conversas,
    -- A PRIMEIRA e a última. A primeira é "desde quando esta pessoa nos
    -- conhece", que é a coluna que se lê para saber se o anúncio da semana
    -- passada trouxe alguém; a última é o que diz quem sumiu.
    min(m.timestamp) as primeira_mensagem,
    max(m.timestamp) as ultima_mensagem,
    count(*) filter (where m.direction = 'incoming') as recebidas,
    count(*) filter (where m.direction = 'outgoing') as enviadas
  from enderecos e
  join public.messages m
    on m.organization_id = e.organization_id
   and m.contact_address = e.address
  group by e.contact_id
),

compromissos as (
  select
    e.contact_id,
    count(*) as compromissos,
    count(*) filter (where a.status = 'scheduled') as marcados,
    count(*) filter (where a.status = 'done') as atendidos,
    count(*) filter (where a.status = 'no_show') as faltas,
    max(a.starts_at) as ultimo_horario,
    /**
     * Quanto esta pessoa já CONSUMIU — não necessariamente quanto pagou.
     *
     * Só `done`. Marcado ainda não aconteceu, cancelado não aconteceu e falta
     * não consumiu — somar qualquer um deles faria a lista dizer que o cliente
     * que nunca apareceu é o melhor da casa.
     *
     * O que saiu daqui e não entrou no caixa está em `fiado`, logo abaixo: a
     * tela mostra os dois lado a lado ("R$ 90 · Deve R$ 45") porque um sem o
     * outro descreve o cliente errado.
     *
     * Do compromisso e não do catálogo, porque preço muda: o corte de 45 hoje
     * custa 55 em outubro, e o histórico tem de continuar dizendo o que foi
     * cobrado naquele dia.
     */
    coalesce(sum(a.price) filter (where a.status = 'done'), 0) as gasto,

    /**
     * Quem pagou, e quem ficou devendo.
     *
     * `payment_method` mora no `extra` do compromisso e distingue coisas que a
     * soma de dinheiro não distingue: `courtesy` é de graça e `credit` é
     * FIADO — atendimento feito, dinheiro não entrou. Tratar os dois como
     * pagamento faria a lista chamar de bom pagador quem nunca pagou, e é
     * exatamente ao contrário que a barbearia usa isso.
     *
     * "Quem me deve" não existia em lugar nenhum do produto, e é a pergunta
     * que se faz no fim do mês numa barbearia de bairro. - 2026/08/18
     */
    count(*) filter (
      where a.status = 'done'
        and a.extra ->> 'payment_method' is not null
        and a.extra ->> 'payment_method' not in ('courtesy', 'credit')
    ) as pagamentos,

    coalesce(
      sum(a.price) filter (
        where a.status = 'done' and a.extra ->> 'payment_method' = 'credit'
      ),
      0
    ) as fiado
  from enderecos e
  join public.appointments a
    on a.organization_id = e.organization_id
   and a.contact_address = e.address
  group by e.contact_id
),

/**
 * O que esta pessoa pagou por COBRANÇA, que é outra coisa.
 *
 * Os compromissos acima respondem "veio e pagou o atendimento". Isto responde
 * "recebeu uma cobrança e quitou" — e numa loja que vende plano e não marca
 * hora, é a única das duas que existe. Sem isto, a tela de contatos chamava de
 * "não pagou" quem paga religiosamente todo mês.
 *
 * Colunas próprias, e não somadas às antigas: misturar faria "gasto" significar
 * uma coisa na barbearia e outra no negócio digital, e ninguém saberia qual
 * está lendo.
 *
 * ## Assinante é quem tem PRAZO CORRENDO
 *
 * Não é quem já pagou uma cobrança — isso é cliente. É quem tem cobrança paga,
 * com validade, cujo vencimento ainda não chegou. A diferença decide com quem
 * falar hoje: quem comprou um corte avulso em maio não é o mesmo caso de quem
 * tem plano vencendo sexta.
 */
cobrado as (
  select
    e.contact_id,
    count(*) filter (where cb.status = 'paga') as cobrancas_pagas,
    coalesce(
      sum(cb.valor) filter (where cb.status = 'paga'), 0
    ) as total_pago,
    count(*) filter (where cb.status = 'aberta') as cobrancas_abertas,
    coalesce(
      sum(cb.valor) filter (where cb.status = 'aberta'), 0
    ) as total_aberto,
    -- O vencimento mais LONGE entre as assinaturas pagas: renovar antes da hora
    -- soma prazo, e o que vale é até quando o acesso vai.
    max(cb.vence_em) filter (
      where cb.status = 'paga' and cb.validade_dias is not null
    ) as assina_ate,

    /**
     * Desde quando esta pessoa assina — a PRIMEIRA assinatura paga.
     *
     * Sem ela, quem atende via "vence em 05/08" e não sabia se era alguém do
     * mês passado ou de dois anos atrás. É a diferença entre insistir na
     * renovação e deixar ir: quem paga há dois anos e atrasou três dias vale
     * um telefonema; quem comprou uma vez, não necessariamente.
     *
     * Do primeiro PAGAMENTO e não do `created_at` do contato: a conversa pode
     * ter começado meses antes de virar venda, e "cliente desde" que conta a
     * conversa infla o tempo de casa de todo mundo que só perguntou o preço.
     */
    min(cb.paga_em) filter (
      where cb.status = 'paga' and cb.validade_dias is not null
    ) as assina_desde,

    /**
     * Como ele pagou a ÚLTIMA vez, e de quantos em quantos dias renova.
     *
     * A última e não a primeira: o que se quer saber é como a próxima vai
     * entrar. Quem começou no dinheiro e hoje paga pelo link não é um caso de
     * cobrança manual, e tratá-lo como tal faz alguém sair atrás de um
     * pagamento que já se resolve sozinho.
     *
     * `array_agg` ordenado e a primeira posição, porque não existe um
     * `last_value` que se possa usar dentro de um agregado com `filter`. Os
     * nulos ficam no fim: cobrança antiga sem método gravado não pode ganhar
     * de uma recente que tem.
     */
    (array_agg(cb.metodo order by cb.paga_em desc nulls last) filter (
      where cb.status = 'paga' and cb.validade_dias is not null
    ))[1] as metodo_assinatura,

    (array_agg(cb.validade_dias order by cb.paga_em desc nulls last) filter (
      where cb.status = 'paga' and cb.validade_dias is not null
    ))[1] as ciclo_dias
  from enderecos e
  join public.cobrancas cb
    on cb.organization_id = e.organization_id
   and cb.contact_address = e.address
  group by e.contact_id
),

/**
 * De qual anúncio esta pessoa veio.
 *
 * A PRIMEIRA que carrega `referral`, e não a última: o que interessa é o que
 * trouxe a pessoa. Quem clica num segundo anúncio meses depois já era cliente,
 * e trocar a origem apagaria a resposta da pergunta que a loja faz — "quanto
 * este anúncio me trouxe de gente nova".
 *
 * `source_id` é o identificador do anúncio na Meta e é por ele que se junta;
 * `headline` é o que se mostra na tela enquanto ninguém resolveu o nome de
 * verdade pela Marketing API. Nomes de campanha mudam, identificadores não.
 */
origem as (
  select distinct on (e.contact_id)
    e.contact_id,
    m.content -> 'referral' ->> 'source_id' as anuncio_id,
    m.content -> 'referral' ->> 'source_type' as anuncio_tipo,
    m.content -> 'referral' ->> 'headline' as anuncio_titulo,
    m.content -> 'referral' ->> 'ctwa_clid' as anuncio_clique,
    m.timestamp as veio_em
  from enderecos e
  join public.messages m
    on m.organization_id = e.organization_id
   and m.contact_address = e.address
  where m.content -> 'referral' is not null
  order by e.contact_id, m.timestamp asc
)

select
  c.id,
  c.organization_id,
  c.name,
  c.tags,
  c.status,
  c.created_at,

  coalesce(f.conversas, 0) as conversas,
  f.primeira_mensagem,
  f.ultima_mensagem,
  coalesce(f.recebidas, 0) as recebidas,
  coalesce(f.enviadas, 0) as enviadas,

  coalesce(p.compromissos, 0) as compromissos,
  coalesce(p.marcados, 0) as compromissos_marcados,
  coalesce(p.atendidos, 0) as atendidos,
  coalesce(p.faltas, 0) as faltas,
  p.ultimo_horario,
  coalesce(p.gasto, 0) as gasto,
  coalesce(p.pagamentos, 0) as pagamentos,
  coalesce(p.fiado, 0) as fiado,

  o.anuncio_id,
  o.anuncio_tipo,
  o.anuncio_titulo,
  o.anuncio_clique,
  o.veio_em,

  -- As três perguntas da tela, já respondidas aqui para o filtro não ter de
  -- recombinar contagens no navegador.
  (o.anuncio_id is not null) as veio_de_anuncio,
  (coalesce(p.compromissos, 0) > 0) as agendou,
  (coalesce(p.pagamentos, 0) > 0) as pagou,
  (coalesce(p.fiado, 0) > 0) as deve,
  (coalesce(f.recebidas, 0) > 0 and coalesce(f.enviadas, 0) = 0) as sem_resposta,

  -- Cobranças, no FIM. `create or replace view` compara posição por posição, e
  -- campo novo no meio é lido como renomeação — erro 42P16, e a migração não
  -- sobe. Já aconteceu neste arquivo em 2026/08/18.
  coalesce(b.cobrancas_pagas, 0) as cobrancas_pagas,
  coalesce(b.total_pago, 0) as total_pago,
  coalesce(b.cobrancas_abertas, 0) as cobrancas_abertas,
  coalesce(b.total_aberto, 0) as total_aberto,
  b.assina_ate,

  -- Assinante é PRAZO CORRENDO, e não histórico de pagamento. Quem já foi
  -- assinante e deixou vencer aparece como cliente, que é o que ele é — e é
  -- exatamente a pessoa para quem se manda uma mensagem de volta.
  (b.assina_ate is not null and b.assina_ate > now()) as assinante,
  (coalesce(b.cobrancas_pagas, 0) > 0) as ja_pagou_cobranca,
  (coalesce(b.cobrancas_abertas, 0) > 0) as tem_cobranca_aberta,

  -- Desde quando assina, como paga e de quantos em quantos dias. As três só
  -- existem para quem tem assinatura: em contato de barbearia vêm nulas, e a
  -- tela não desenha o bloco. No FIM, pela regra do 42P16 lá em cima.
  b.assina_desde,
  b.metodo_assinatura,
  b.ciclo_dias
from public.contacts c
left join falas f on f.contact_id = c.id
left join compromissos p on p.contact_id = c.id
left join cobrado b on b.contact_id = c.id
left join origem o on o.contact_id = c.id;

comment on view public.contact_overview is
  'Contatos com o que a tela precisa para filtrar: origem do anúncio, se agendou, se ficou sem resposta, e se é assinante.';
