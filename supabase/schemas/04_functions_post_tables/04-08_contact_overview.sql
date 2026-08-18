-- O que se precisa saber de um contato sem abrir a ficha dele.
--
-- A tela de Contatos era uma lista de telefones sem nome, em ordem de chegada.
-- Com anúncio rodando isso vira uma pilha: em 2026/08/18 a barbearia tinha 200
-- linhas, 189 sem nome e nenhuma etiqueta, e a pergunta "quem destes agendou"
-- não tinha resposta em lugar nenhum da tela.
--
-- As respostas já existiam, espalhadas: a conversa diz se respondeu, o
-- compromisso diz se agendou, e a PRIMEIRA mensagem de quem veio de anúncio
-- carrega qual anúncio foi. Esta visão junta as três num lugar só, para a lista
-- poder filtrar sem que o navegador leia a base inteira.
--
-- ## Por que uma visão, e não colunas no contato
--
-- Tudo aqui é derivado de fatos que já estão gravados. Como coluna, cada um
-- precisaria de um gatilho para se manter em dia, e o dia em que um gatilho
-- falhar a tela passa a mentir sobre quem agendou — que é pior do que não
-- mostrar. Derivado, não tem como sair de sincronia.
--
-- ## `security_invoker`
--
-- Sem isto a visão roda com os privilégios de quem a criou e a RLS das tabelas
-- de baixo é ignorada: uma barbearia veria os contatos de outra. É o tipo de
-- falha que não aparece em teste nenhum feito com um cliente só.
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
    max(a.starts_at) as ultimo_horario
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
  f.ultima_mensagem,
  coalesce(f.recebidas, 0) as recebidas,
  coalesce(f.enviadas, 0) as enviadas,

  coalesce(p.compromissos, 0) as compromissos,
  coalesce(p.marcados, 0) as compromissos_marcados,
  p.ultimo_horario,

  o.anuncio_id,
  o.anuncio_tipo,
  o.anuncio_titulo,
  o.anuncio_clique,
  o.veio_em,

  -- As três perguntas da tela, já respondidas aqui para o filtro não ter de
  -- recombinar contagens no navegador.
  (o.anuncio_id is not null) as veio_de_anuncio,
  (coalesce(p.compromissos, 0) > 0) as agendou,
  (coalesce(f.recebidas, 0) > 0 and coalesce(f.enviadas, 0) = 0) as sem_resposta
from public.contacts c
left join falas f on f.contact_id = c.id
left join compromissos p on p.contact_id = c.id
left join origem o on o.contact_id = c.id;

comment on view public.contact_overview is
  'Contatos com o que a tela precisa para filtrar: origem do anúncio, se agendou, se ficou sem resposta.';
