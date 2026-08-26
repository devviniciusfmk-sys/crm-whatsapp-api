-- Transformar uma campanha em mensagens.
--
-- Estas três funções são o lado que produz; quem consome é a fila em
-- `04-03_dispatch_queue.sql` e o dispatcher de sempre. Ficam em
-- 04_functions_post_tables porque recebem `public.campaigns` e `public.contacts`
-- como parâmetro, e tipo de tabela na assinatura é resolvido na criação da
-- função — 02_functions roda antes de as tabelas existirem. - 2026/08/03

-- Quem entra no público da campanha.
--
-- O filtro é guardado como jsonb e não como SQL porque quem escreve é a tela, e
-- tela não deve montar consulta. Vocabulário:
--
--   {}                                    todo mundo com conversa no número
--   {"tags": ["vip"], "match": "any"}     tem alguma destas etiquetas
--   {"tags": ["vip","rs"], "match":"all"} tem todas estas
--   {"contact_ids": [...]}                esta lista, e mais ninguém
--
-- A primeira versão disto filtrava por cidade, estado e "tem e-mail". Era um
-- vocabulário desenhado a partir das colunas que a ficha tinha, não a partir de
-- como alguém pensa um disparo — ninguém abre a tela querendo falar com "quem
-- tem e-mail preenchido em Pelotas". Pensa "os VIP", "quem sumiu". Isso é
-- etiqueta, e é o que as ferramentas do ramo usam. - 2026/08/04
--
-- `match` é `any` por padrão. Marcar duas etiquetas e receber a interseção
-- vazia é o resultado surpreendente; a união é o que a pessoa espera de marcar
-- mais uma caixa.
create function public.matches_campaign_audience(
  p_contact public.contacts,
  p_audience jsonb
)
returns boolean
language sql
stable
as $$
  select
    (
      not p_audience ? 'contact_ids'
      or p_contact.id::text in (
        select jsonb_array_elements_text(p_audience -> 'contact_ids')
      )
    )
    and (
      not p_audience ? 'tags'
      or jsonb_array_length(p_audience -> 'tags') = 0
      or case coalesce(p_audience ->> 'match', 'any')
        when 'all' then p_contact.tags @> (
          select array_agg(value)
          from jsonb_array_elements_text(p_audience -> 'tags') as value
        )
        else p_contact.tags && (
          select array_agg(value)
          from jsonb_array_elements_text(p_audience -> 'tags') as value
        )
      end
    )
    and (
      not p_audience ? 'status'
      or p_contact.status = p_audience ->> 'status'
    );
$$;

-- Monta o `content` da mensagem de template para um contato.
--
-- O formato de saída é o `content` v1 que o dispatcher já sabe converter:
-- `{version, type: 'data', kind: 'template', data: <objeto template da Meta>}`.
-- O dispatcher faz `template: content.data` direto no payload, então o que está
-- em `data` precisa ser exatamente o que a Meta espera.
--
-- As variáveis vêm de `campaigns.variables`, por posição:
--
--   {"body": [{"from": "contact.name", "fallback": "cliente"},
--             {"literal": "20%"}]}
--
-- `from` aceita `contact.name` e qualquer chave de `contacts.extra`
-- (`contact.city`, `contact.email`, ...). `literal` é texto fixo igual para
-- todos. `fallback` é o que entra quando o campo está vazio.
--
-- **Devolve NULL quando uma variável não tem valor nem reserva**, e quem chama
-- descarta esse destinatário. É deliberado: template com parâmetro vazio ou é
-- recusado pela Meta (erro 132000) ou chega como "Olá , tudo bem?" — e mandar
-- promoção com o nome faltando é pior do que não mandar. Mesmo princípio do
-- `contact_details`: só o que existe de verdade.
--
-- Quebra de linha e tabulação viram espaço porque a Meta recusa parâmetro que
-- as contenha, e é o tipo de coisa que só aparece quando alguém colou um
-- endereço de duas linhas na ficha.
create function public.render_campaign_template(
  p_campaign public.campaigns,
  p_contact public.contacts
)
returns jsonb
language plpgsql
stable
as $$
declare
  v_sections text[] := array['header', 'body'];
  v_section text;
  v_spec jsonb;
  v_slot jsonb;
  v_params jsonb;
  v_value text;
  v_components jsonb := '[]'::jsonb;
begin
  foreach v_section in array v_sections
  loop
    v_spec := p_campaign.variables -> v_section;

    if v_spec is null or jsonb_typeof(v_spec) <> 'array'
       or jsonb_array_length(v_spec) = 0 then
      continue;
    end if;

    v_params := '[]'::jsonb;

    for v_slot in select jsonb_array_elements(v_spec)
    loop
      if v_slot ? 'literal' then
        v_value := v_slot ->> 'literal';
      elsif (v_slot ->> 'from') = 'contact.name' then
        v_value := p_contact.name;
      elsif (v_slot ->> 'from') like 'contact.%' then
        v_value := p_contact.extra ->> substr(v_slot ->> 'from', 9);
      else
        v_value := null;
      end if;

      if v_value is null or btrim(v_value) = '' then
        v_value := v_slot ->> 'fallback';
      end if;

      -- sem valor e sem reserva: este destinatário não recebe nada
      if v_value is null or btrim(v_value) = '' then
        return null;
      end if;

      v_value := btrim(regexp_replace(v_value, '[\n\r\t]+', ' ', 'g'));

      v_params := v_params
        || jsonb_build_object('type', 'text', 'text', v_value);
    end loop;

    v_components := v_components
      || jsonb_build_object('type', v_section, 'parameters', v_params);
  end loop;

  return jsonb_build_object(
    'version', '1',
    'type', 'data',
    'kind', 'template',
    'data',
      jsonb_build_object(
        'name', p_campaign.template_name,
        'language', jsonb_build_object(
          'code', p_campaign.template_language,
          'policy', 'deterministic'
        )
      )
      || case
           when jsonb_array_length(v_components) > 0
             then jsonb_build_object('components', v_components)
           else '{}'::jsonb
         end
  );
end;
$$;

-- Quem receberia esta campanha, e o que cada um receberia.
--
-- Existe separada de `start_campaign` por uma razão só: a tela precisa dizer
-- "isto vai para 3.412 pessoas" **antes** de alguém apertar o botão, e a
-- contagem tem de ser a mesma lista que sai depois. Reescrever o critério em
-- dois lugares seria garantir que um dia a prévia diga 3.412 e o disparo mande
-- 2.900, e ninguém saberia qual dos dois estava errado.
--
-- Três coisas decididas aqui:
--
-- **Descadastro barra na origem**, não esperando a Meta recusar. E só vale para
-- marketing: quem saiu da lista de promoção continua recebendo confirmação de
-- horário.
--
-- **Conversa OU consentimento registrado.** A regra era só a conversa, por duas
-- razões boas: `messages.conversation_id` é NOT NULL, e disparo para quem nunca
-- falou com o número é o que gera bloqueio e derruba a nota de qualidade.
--
-- A segunda continua valendo para uma lista fria qualquer, e deixa de valer
-- para quem preencheu formulário, marcou a caixa ou mandou "quero" em outro
-- canal. Essa pessoa pediu para receber, e a regra da casa estava mais dura que
-- a da própria Meta, que exige opt-in e não conversa prévia:
--
--   tem conversa                    entra, como sempre entrou
--   sem conversa, com opt-in        entra, e `start_campaign` abre a conversa
--   sem conversa, sem opt-in        fica de fora
--
-- Uma porta a mais, e não uma porta aberta. Havendo mais de uma conversa, vale
-- a mais recente.
--
-- `conversation_id` passa a poder vir nulo, e é de propósito: a prévia precisa
-- contar exatamente a mesma lista que sai depois, e criar conversa dentro de
-- uma função `stable` é impossível. Quem cria é o disparo. - 2026/08/23
--
-- **Quem não pôde ser renderizado fica de fora**, em vez de receber um template
-- com buraco no meio. - 2026/08/03
create function public.campaign_recipients(p_campaign public.campaigns)
returns table (
  contact_address text,
  conversation_id uuid,
  content jsonb
)
language sql
stable
as $$
  select distinct on (ca.address)
    ca.address,
    conv.id,
    rendered.content
  from public.contacts_addresses as ca
  join public.contacts as c
    on c.id = ca.contact_id
  left join public.conversations as conv
    on conv.organization_id = ca.organization_id
   and conv.service = ca.service
   and conv.contact_address = ca.address
   and conv.organization_address = p_campaign.organization_address
  cross join lateral (
    select public.render_campaign_template(p_campaign, c) as content
  ) as rendered
  where ca.organization_id = p_campaign.organization_id
    and ca.service = p_campaign.service
    and ca.status = 'active'
    and (
      p_campaign.template_category <> 'marketing'
      or ca.marketing_opt_out_at is null
    )
    -- Conversa OU consentimento registrado. Sem um dos dois, fica de fora.
    and (conv.id is not null or ca.marketing_opt_in_at is not null)
    and public.matches_campaign_audience(c, p_campaign.audience)
    and rendered.content is not null
  order by ca.address, conv.updated_at desc nulls last;
$$;

-- As etiquetas que existem nesta organização, com quantos contatos cada uma.
--
-- Sai da própria coluna, sem catálogo separado. Um cadastro de etiquetas seria
-- mais uma tela para manter e o passo em que a pessoa desiste de etiquetar; a
-- lista de etiquetas é consequência de etiquetar, não pré-requisito.
--
-- A contagem vai junto porque é o que torna a lista útil na hora de escolher:
-- "vip (312)" responde sozinho se vale a pena mandar. - 2026/08/04
create function public.organization_tags(p_organization_id uuid)
returns table (tag text, contacts integer)
language sql
stable
security definer
set search_path to ''
as $$
  select tag, count(*)::integer
  from public.contacts as c
  cross join lateral unnest(c.tags) as tag
  where c.organization_id = p_organization_id
    and c.organization_id in (select public.get_authorized_orgs('member'))
  group by tag
  order by count(*) desc, tag;
$$;

-- Quantas pessoas um público atingiria, antes de a campanha existir.
--
-- A tela de criação precisa mostrar o alcance mudando enquanto a pessoa marca
-- etiquetas, e nesse momento não há campanha salva para contar. Em vez de
-- reescrever o critério aqui — que foi o erro que este arquivo já cometeu uma
-- vez — monta uma linha de campanha em memória e delega para
-- `campaign_recipients`. Um critério só, dois pontos de entrada.
--
-- As variáveis vão vazias de propósito: nesta altura ainda não foram
-- preenchidas, e contar quem "não renderiza" antes de existir o que renderizar
-- daria zero para todo mundo.
create function public.count_audience(
  p_organization_id uuid,
  p_organization_address text,
  p_template_category text,
  p_audience jsonb
)
returns integer
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
  v_campaign public.campaigns;
  v_count integer;
begin
  if p_organization_id not in (select public.get_authorized_orgs('member')) then
    raise exception 'not authorized'
      using errcode = 'insufficient_privilege';
  end if;

  v_campaign.organization_id := p_organization_id;
  v_campaign.organization_address := p_organization_address;
  v_campaign.service := 'whatsapp'::public.service;
  v_campaign.template_category := p_template_category;
  v_campaign.template_name := '';
  v_campaign.template_language := '';
  v_campaign.variables := '{}'::jsonb;
  v_campaign.audience := coalesce(p_audience, '{}'::jsonb);

  select count(*) into v_count
  from public.campaign_recipients(v_campaign);

  return v_count;
end;
$$;

-- Quantas pessoas a campanha atinge, para a prévia.
--
-- Mesma lista do disparo, contada. Nível `member` porque é leitura: quem atende
-- pode conferir o alcance antes de pedir para o administrador disparar.
create function public.count_campaign_audience(p_campaign_id uuid)
returns integer
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
  v_campaign public.campaigns;
  v_count integer;
begin
  select * into v_campaign
  from public.campaigns
  where id = p_campaign_id
    and organization_id in (select public.get_authorized_orgs('member'));

  if not found then
    raise exception 'campaign not found or not authorized'
      using errcode = 'insufficient_privilege';
  end if;

  select count(*) into v_count
  from public.campaign_recipients(v_campaign);

  return v_count;
end;
$$;

-- Materializa o público da campanha em mensagens, e põe a campanha para correr.
--
-- É um `insert ... select` só. Cinquenta mil linhas numa transação, e não um
-- laço de edge function — o banco já sabe fazer isso, e uma função que iterasse
-- destinatário por destinatário levaria minutos e morreria no meio.
--
-- O `on conflict do nothing` sobre o índice parcial
-- `messages_campaign_recipient_key` é a idempotência inteira. Clicar duas vezes,
-- retomar uma campanha pausada, refazer depois de uma queda: nenhum destes
-- gera uma linha a mais. Não existe deduplicação em lugar nenhum além daqui.
--
-- Quem entra e o que cada um recebe está em `campaign_recipients`, que é a
-- mesma lista que a prévia conta. Aqui só se decide quando sai.
--
-- O horário da mensagem é `scheduled_at`, ou agora. Vale lembrar que a fila só
-- pega o que tem mais de um minuto, então uma campanha disparada "agora" começa
-- a sair no minuto seguinte — o que de quebra dá uma janela para cancelar.
--
-- E é aqui que nasce a conversa de quem entrou por opt-in registrado e nunca
-- escreveu neste número. `messages.conversation_id` é NOT NULL e continua
-- sendo: a mensagem de campanha precisa morar em algum lugar, e é nesse lugar
-- que a resposta dela vai cair. Criar a conversa no disparo é o que torna a
-- resposta possível. - 2026/08/23
create function public.start_campaign(p_campaign_id uuid)
returns integer
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_campaign public.campaigns;
  v_inserted integer;
begin
  select * into v_campaign
  from public.campaigns
  where id = p_campaign_id
    and organization_id in (select public.get_authorized_orgs('admin'))
  for update;

  if not found then
    raise exception 'campaign not found or not authorized'
      using errcode = 'insufficient_privilege';
  end if;

  if v_campaign.status not in (
    'draft'::public.campaign_status,
    'scheduled'::public.campaign_status,
    'paused'::public.campaign_status
  ) then
    raise exception 'campaign % is %; only draft, scheduled or paused can start',
      p_campaign_id, v_campaign.status;
  end if;

  -- Antes do insert das mensagens, e não durante: o insert lê
  -- `campaign_recipients`, e a lista tem de estar completa quando ele roda.
  --
  -- `on conflict do nothing` porque duas campanhas podem sair no mesmo minuto
  -- para a mesma pessoa, e a segunda não pode estourar por achar a conversa que
  -- a primeira criou.
  insert into public.conversations (
    organization_id,
    service,
    organization_address,
    contact_address,
    status
  )
  select
    v_campaign.organization_id,
    v_campaign.service,
    v_campaign.organization_address,
    r.contact_address,
    'open'
  from public.campaign_recipients(v_campaign) as r
  where r.conversation_id is null
  on conflict do nothing;

  insert into public.messages (
    organization_id,
    conversation_id,
    campaign_id,
    direction,
    service,
    organization_address,
    contact_address,
    content,
    timestamp
  )
  select
    v_campaign.organization_id,
    -- Relido depois de criar: quem entrou sem conversa agora tem uma.
    coalesce(
      r.conversation_id,
      (
        select conv.id
        from public.conversations as conv
        where conv.organization_id = v_campaign.organization_id
          and conv.service = v_campaign.service
          and conv.organization_address = v_campaign.organization_address
          and conv.contact_address = r.contact_address
        order by conv.updated_at desc
        limit 1
      )
    ),
    v_campaign.id,
    'outgoing'::public.direction,
    v_campaign.service,
    v_campaign.organization_address,
    r.contact_address,
    r.content,
    coalesce(v_campaign.scheduled_at, now())
  from public.campaign_recipients(v_campaign) as r
  on conflict (campaign_id, contact_address) where campaign_id is not null
  do nothing;

  get diagnostics v_inserted = row_count;

  update public.campaigns
  set status = 'running'::public.campaign_status,
      started_at = coalesce(started_at, now())
  where id = p_campaign_id;

  return v_inserted;
end;
$$;

-- Fecha as campanhas cuja fila esvaziou. Roda no cron.
--
-- Sem isto a campanha fica em `running` para sempre depois da última mensagem
-- sair, e a tela passa a mostrar "correndo" para coisa que acabou semana
-- passada — que é pior do que não mostrar estado nenhum, porque parece que
-- alguma coisa travou.
--
-- "Esvaziou" é não sobrar mensagem que ainda possa ser enviada. A janela de 12
-- horas é a mesma da fila: passado esse prazo a mensagem não é mais despachada
-- por ninguém, então continuar esperando por ela seria esperar para sempre.
-- Sem essa cláusula, uma única mensagem presa em `pending` — porque o número
-- ficou fora do ar naquela hora — seguraria a campanha inteira em aberto.
--
-- Campanha que não materializou ninguém fecha na primeira passada. É o certo:
-- não há o que esperar, e "concluída, zero enviadas" conta a história melhor do
-- que "correndo" eternamente.
create function public.complete_finished_campaigns()
returns integer
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_completed integer;
begin
  update public.campaigns as c
  set status = 'completed'::public.campaign_status,
      completed_at = now()
  where c.status = 'running'::public.campaign_status
    and not exists (
      select 1
      from public.messages as m
      where m.campaign_id = c.id
        and m.timestamp >= now() - interval '12 hours'
        and m.status ->> 'accepted' is null
        and m.status ->> 'sent' is null
        and m.status ->> 'delivered' is null
        and m.status ->> 'read' is null
        and m.status ->> 'failed' is null
    );

  get diagnostics v_completed = row_count;

  return v_completed;
end;
$$;

-- Apaga a campanha, e antes disso descarta o que ela ainda não enviou.
--
-- A ordem importa, e é a razão de isto ser função no banco em vez de um
-- `delete` do navegador. A chave estrangeira de `messages.campaign_id` é
-- `on delete set null`, de propósito: quem já recebeu tem de continuar vendo a
-- mensagem na conversa depois que a campanha for descartada. Só que a fila
-- despacha justamente `campaign_id is null or c.status = 'running'` — então
-- apagar a linha da campanha e deixar as pendentes para trás transformaria o
-- que ainda não saiu em mensagem solta, elegível na hora e na frente da fila,
-- porque a prioridade de conversa é dada por `campaign_id is not null`.
--
-- Isto é, apagar dispararia o resto do disparo. O botão faria o oposto do nome.
--
-- Por isso as pendentes morrem primeiro, na mesma transação. "Pendente" é a
-- mesma definição da fila: nada que já tenha sido aceito, enviado, entregue,
-- lido ou falhado. O que chegou na Meta fica gravado — a pessoa recebeu, e
-- história recebida não se reescreve; só perde o vínculo com a campanha.
--
-- **Correndo não apaga.** Não é preciosismo: uma linha reservada pela fila pode
-- estar no meio do POST para a Meta neste instante, e apagá-la debaixo do
-- remetente é a única forma de a mensagem sair sem ficar registro. Pausar
-- primeiro fecha essa janela na rodada seguinte, e é um clique. Depois de
-- pausada, apagar leva junto o que sobrou.
--
-- Admin, como o resto da tabela: quem pode disparar para a base inteira é quem
-- pode apagar o disparo.
--
-- Devolve quantas mensagens não enviadas foram descartadas — a tela precisa
-- disso para dizer "cancelei 812 que ainda não tinham saído" em vez de sumir
-- com a campanha em silêncio. - 2026/08/04
create function public.delete_campaign(p_campaign_id uuid)
returns integer
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_campaign public.campaigns;
  v_discarded integer;
begin
  select * into v_campaign
  from public.campaigns
  where id = p_campaign_id
    and organization_id in (select public.get_authorized_orgs('admin'))
  for update;

  if not found then
    raise exception 'campaign not found or not authorized'
      using errcode = 'insufficient_privilege';
  end if;

  if v_campaign.status = 'running'::public.campaign_status then
    raise exception 'campaign % is running; pause it before deleting',
      p_campaign_id;
  end if;

  delete from public.messages
  where campaign_id = p_campaign_id
    and status ->> 'accepted' is null
    and status ->> 'sent' is null
    and status ->> 'delivered' is null
    and status ->> 'read' is null
    and status ->> 'failed' is null;

  get diagnostics v_discarded = row_count;

  delete from public.campaigns
  where id = p_campaign_id;

  return v_discarded;
end;
$$;
