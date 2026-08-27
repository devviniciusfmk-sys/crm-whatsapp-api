-- O funil de vendas: um negócio por prospect, do primeiro contato até
-- fechado ou perdido. `contacts` é quem já conversou pelo WhatsApp; um
-- negócio pode nascer ANTES disso — importado de uma lista de prospecção,
-- por exemplo — e só ganha `conversation_id` quando alguém de fato manda a
-- primeira mensagem.
--
-- `externo_id`+`origem` existem para sincronização com fontes externas
-- (uma base de leads gerada e pontuada por IA fora deste projeto): a
-- combinação identifica o mesmo prospect entre execuções, sem duplicar a
-- cada sincronização. `origem = 'manual'` por padrão cobre o caso comum —
-- alguém cadastrando um negócio à mão, sem fonte externa nenhuma.
create table public.negocios (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  externo_id text,
  origem text not null default 'manual',
  nome text not null,
  telefone text,
  cidade text,
  categoria text,
  nicho text,
  estagio text not null default 'novo'
    check (estagio in ('novo','contatado','qualificado','proposta','fechado','perdido')),
  valor_estimado numeric,
  score_ia real,
  veredito_ia text,
  motivo_ia text,
  abertura_sugerida text,
  dores_identificadas jsonb,
  conversation_id uuid,
  extra jsonb,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

create index negocios_organization_id_idx on public.negocios (organization_id);

create index negocios_estagio_idx on public.negocios (organization_id, estagio);

-- Único por organização+origem+externo_id, e só quando externo_id existe —
-- um negócio manual (sem fonte externa) nunca colide com outro manual.
create unique index negocios_externo_idx on public.negocios (organization_id, origem, externo_id)
  where externo_id is not null;

create trigger set_extra
before update
on public.negocios
for each row
when (
  new.extra is not null
)
execute function public.merge_update('extra');

create trigger set_updated_at before update on public.negocios
  for each row execute function public.moddatetime('atualizado_em');
