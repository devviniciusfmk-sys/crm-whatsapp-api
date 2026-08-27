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
  -- 'descoberto' é o único estágio FORA do Kanban (/funil só lista
  -- ESTAGIOS_NEGOCIO, que começa em 'novo') — é onde um lead sincronizado
  -- automaticamente fica até alguém escolher trabalhá-lo na tela de
  -- pesquisa. Continua sendo o default de quem cadastra um negócio à mão,
  -- não de quem sincroniza: sincronizar_negocios_externos passa
  -- 'descoberto' explícito; um negócio manual nasce já 'novo' porque
  -- alguém decidiu digitar aquilo de propósito.
  estagio text not null default 'novo'
    check (estagio in ('descoberto','novo','contatado','qualificado','proposta','fechado','perdido')),
  valor_estimado numeric,
  score_ia real,
  veredito_ia text,
  motivo_ia text,
  abertura_sugerida text,
  dores_identificadas jsonb,
  conversation_id uuid,
  -- `cidade`/`estado` que vêm da fonte externa quase sempre chegam vazios —
  -- só o endereço completo é confiável. Estes dois são o que a sincronização
  -- CONSEGUE extrair dali (regex sobre "..., Cidade - UF, CEP"), guardados
  -- separados do dado bruto, e `origem_localizacao` diz a origem em vez de
  -- fingir certeza sobre o que não deu pra extrair — medido contra a base
  -- real: 1136 de 1142 resolvem (99,5%), os 6 que sobram ficam
  -- 'desconhecido', explícitos, não escondidos atrás de um filtro que
  -- simplesmente os faria sumir.
  estado_normalizado text,
  cidade_normalizada text,
  origem_localizacao text
    check (origem_localizacao in ('extraido_endereco', 'desconhecido')),
  -- Quem está trabalhando o negócio — atribuído sozinho na primeira vez que
  -- alguém marca reunião (`marcar_reuniao_negocio`), não escolhido à mão.
  -- Também é quem recebe a comissão em `comissoes`.
  responsavel_id uuid references auth.users(id),
  -- Nulo = sem reunião marcada. Preenchido e limpo só pelas funções
  -- `marcar_reuniao_negocio`/`desmarcar_reuniao_negocio` (04-33), nunca
  -- direto por update na tabela — é o que credita/estorna a comissão.
  reuniao_em timestamptz,
  -- Por que não fechou — quatro chaves fixas, não texto livre (mesmo
  -- raciocínio de motivoDaPerda.ts no front, domínio diferente: lá é teste
  -- IPTV, aqui é negócio de SDR; texto livre não soma num relatório, um
  -- conjunto fechado soma). Só existe quando estagio='perdido' — o check
  -- de tabela logo abaixo garante isso, então um negócio que sai de
  -- 'perdido' não carrega motivo órfão.
  motivo_perda text
    check (motivo_perda in ('preco','sem_interesse','concorrente','sumiu')),
  extra jsonb,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  check (motivo_perda is null or estagio = 'perdido')
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
