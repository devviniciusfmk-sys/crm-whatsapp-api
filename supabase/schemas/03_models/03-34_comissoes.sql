-- O ledger de comissão do funil: uma linha por EVENTO (marcar reunião),
-- nunca recalculada. Diferente da comissão de atendimento/recebimento
-- (`agents.extra.commission_percent`, somada ao vivo a cada tela) — aqui
-- o valor é fixo por evento e precisa sobreviver ao negócio mudando de
-- estágio depois, e precisa ser estornável quando a reunião é desmarcada.
-- Sem ledger não existe o que estornar.
--
-- Só as funções em `04-33_negocios_reuniao.sql` escrevem aqui
-- (`marcar_reuniao_negocio`/`desmarcar_reuniao_negocio`) — ver RLS em
-- `05-33_comissoes_rls.sql`.
create table public.comissoes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  negocio_id uuid not null references public.negocios(id) on delete cascade,
  agent_id uuid not null references auth.users(id),
  -- Único tipo por enquanto — ganha mais valores quando a comissão de
  -- retenção (90-120 dias de assinatura ativa) existir.
  tipo text not null default 'reuniao_marcada'
    check (tipo in ('reuniao_marcada')),
  valor numeric not null,
  status text not null default 'ativa'
    check (status in ('ativa', 'estornada')),
  criado_em timestamptz not null default now(),
  estornado_em timestamptz
);

create index comissoes_organization_id_idx on public.comissoes (organization_id);

create index comissoes_agent_id_idx on public.comissoes (organization_id, agent_id);

-- Só uma comissão ATIVA de cada tipo por negócio — é nela que
-- `desmarcar_reuniao_negocio` bate para saber qual linha estornar, e é o
-- que impede reagendar de creditar duas vezes.
create unique index comissoes_negocio_tipo_ativa_idx
  on public.comissoes (negocio_id, tipo) where status = 'ativa';
