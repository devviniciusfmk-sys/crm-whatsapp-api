-- Quem pagou, e quem ficou devendo.
--
-- A forma de pagamento já era gravada em cada atendimento (dinheiro, pix,
-- cartão, fiado, cortesia) e nenhuma tela lia. Ela distingue o que a soma de
-- dinheiro não distingue: cortesia é de graça e fiado é atendimento feito com
-- dinheiro que não entrou. Somados como pagamento, a lista chamaria de bom
-- pagador quem nunca pagou — e é ao contrário que a barbearia usa isso.
--
-- "Quem me deve" não existia em lugar nenhum do produto, e é a pergunta que se
-- faz no fim do mês numa barbearia de bairro.
--
-- Derruba antes de criar: "create or replace view" não sabe inserir coluna no
-- meio e lê isso como renomear a coluna daquela posição (42P16).
-- - 2026/08/18

drop view if exists public.contact_overview;

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
     * Quanto esta pessoa já deixou na casa.
     *
     * Só `done`. Marcado ainda não aconteceu, cancelado não aconteceu e falta
     * não pagou — somar qualquer um deles faria a lista dizer que o cliente
     * que nunca apareceu é o melhor da casa.
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
  (coalesce(f.recebidas, 0) > 0 and coalesce(f.enviadas, 0) = 0) as sem_resposta
from public.contacts c
left join falas f on f.contact_id = c.id
left join compromissos p on p.contact_id = c.id
left join origem o on o.contact_id = c.id;

comment on view public.contact_overview is
  'Contatos com o que a tela precisa para filtrar: origem do anúncio, se agendou, se ficou sem resposta.';
