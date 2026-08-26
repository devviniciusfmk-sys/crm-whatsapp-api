/**
 * # O opt-in vira registro, e abre a campanha para quem ainda não escreveu
 *
 * A campanha só alcançava quem já tinha CONVERSA naquele número. O comentário
 * de `campaign_recipients` explica por quê, e as duas razões eram boas:
 * `messages.conversation_id` é NOT NULL, e disparo para quem nunca falou com o
 * número é o que gera bloqueio e derruba a nota de qualidade.
 *
 * A segunda razão continua verdadeira para uma lista qualquer. Mas ela deixa
 * de valer quando existe **consentimento registrado**: quem preencheu
 * formulário, marcou a caixa, mandou "quero" — essa pessoa pediu para receber,
 * e a regra da casa estava mais dura que a da própria Meta, que exige opt-in e
 * não conversa prévia.
 *
 * ## A origem é obrigatória, e é o ponto inteiro
 *
 * `marketing_opt_in_at` sem `marketing_opt_in_origem` é recusado pelo banco.
 * Sem isso, "opt-in registrado" vira um campo que alguém preenche em massa
 * para destravar o disparo — e aí é a mesma lista de antes com outro nome, com
 * o custo aparecendo na nota de qualidade três semanas depois, quando ninguém
 * mais liga uma coisa à outra.
 *
 * Guardar de onde veio é o que permite responder à pergunta que a LGPD faz —
 * "prove que ele consentiu" — e a que o operador faz: "por que este número
 * está na lista?".
 *
 * ## Colunas, e não `extra`
 *
 * Mesma decisão de `marketing_opt_out_at`, pelas mesmas três razões escritas
 * lá: consentimento não é metadado, precisa entrar em `where` sem ninguém
 * saber procurar dentro de um JSON, e não pode depender de um merge de JSON
 * dar certo. - 2026/08/23
 */
alter table public.contacts_addresses
add column if not exists marketing_opt_in_at timestamp with time zone,
add column if not exists marketing_opt_in_origem text;

comment on column public.contacts_addresses.marketing_opt_in_at is
  'Quando esta pessoa pediu para receber campanha. Exige origem.';

comment on column public.contacts_addresses.marketing_opt_in_origem is
  'Por onde ela pediu. É a prova, e é o que responde "por que ele está na lista".';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'contacts_addresses_opt_in_tem_origem'
  ) then
    alter table public.contacts_addresses
    add constraint contacts_addresses_opt_in_tem_origem
    check (
      marketing_opt_in_at is null
      or nullif(btrim(marketing_opt_in_origem), '') is not null
    );
  end if;
end $$;

/* O `where` da campanha passa por aqui em toda prévia e todo disparo. */
create index if not exists contacts_addresses_opt_in_idx
on public.contacts_addresses (organization_id, service)
where marketing_opt_in_at is not null;

/**
 * # Quem entra na campanha
 *
 * Muda uma coisa e mantém todo o resto: a conversa deixa de ser obrigatória
 * PARA QUEM TEM OPT-IN REGISTRADO. Quem não tem continua precisando dela.
 *
 *   tem conversa                    entra, como sempre entrou
 *   sem conversa, com opt-in        entra, e `start_campaign` abre a conversa
 *   sem conversa, sem opt-in        fica de fora
 *
 * O descadastro continua barrando na origem, e continua valendo só para
 * marketing: quem saiu da lista de promoção segue recebendo confirmação de
 * horário.
 *
 * `conversation_id` passa a poder vir nulo, e é de propósito: a prévia precisa
 * contar exatamente a mesma lista que sai depois, e criar conversa dentro de
 * uma função `stable` é impossível. Quem cria é o disparo. - 2026/08/23
 */
create or replace function public.campaign_recipients(p_campaign public.campaigns)
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
    /* Conversa OU consentimento registrado. Sem um dos dois, fica de fora —
     * que é a regra antiga com uma porta a mais, e não uma porta aberta. */
    and (conv.id is not null or ca.marketing_opt_in_at is not null)
    and public.matches_campaign_audience(c, p_campaign.audience)
    and rendered.content is not null
  order by ca.address, conv.updated_at desc nulls last;
$$;

/**
 * # O disparo abre a conversa de quem ainda não tem
 *
 * `messages.conversation_id` é NOT NULL, e continua sendo — a mensagem de
 * campanha precisa morar em algum lugar, e é nesse lugar que a resposta dela
 * vai cair. Criar a conversa no disparo é o que torna a resposta possível.
 *
 * Antes do insert das mensagens, e não durante: o insert lê
 * `campaign_recipients`, e a lista tem de estar completa quando ele roda.
 *
 * `on conflict do nothing` porque duas campanhas podem sair no mesmo minuto
 * para a mesma pessoa, e a segunda não pode estourar por achar a conversa que
 * a primeira criou. - 2026/08/23
 */
create or replace function public.start_campaign(p_campaign_id uuid)
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

  /* A conversa de quem tem opt-in e ainda não falou com este número. */
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
    /* Relido depois de criar: quem entrou sem conversa agora tem uma. */
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
  /* `updated_at` fica de fora, como no original: quem o mantém é o gatilho da
   * tabela, e escrever aqui seria uma segunda mão no mesmo campo. */
  set status = 'running'::public.campaign_status,
      started_at = coalesce(started_at, now())
  where id = p_campaign_id;

  return v_inserted;
end;
$$;
