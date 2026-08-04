-- Disparo de template aprovado para uma lista de contatos.
--
-- A campanha não envia mensagem. Ela materializa linhas em `public.messages` —
-- e daí para frente o caminho é o mesmo de qualquer mensagem que sai daqui: o
-- dispatcher, a classificação de erro da Meta, os webhooks de status, o
-- billing. Um "enviador de campanha" à parte seria uma segunda implementação de
-- idempotência, de reenvio e de contagem de entrega, e duas implementações
-- divergem na primeira vez que a Meta mudar alguma coisa.
--
-- O que é genuinamente novo aqui é só o ritmo, o público e o descadastro.
-- Todo o resto já existia.
--
-- Numerado 03-04, e não no fim da fila, porque `messages` tem chave estrangeira
-- para cá e estes arquivos são aplicados na ordem alfabética do caminho: uma
-- tabela precisa existir antes de quem a referencia. É o mesmo motivo de
-- `contacts` vir antes de `contacts_addresses`. - 2026/08/03
create table public.campaigns (
  id uuid default gen_random_uuid() not null,
  organization_id uuid not null,
  -- O número que dispara. Não é decoração: o teto de mensagens por segundo e a
  -- nota de qualidade são por número, então a fila e o ritmo se organizam em
  -- torno dele, não da organização.
  organization_address text not null,
  service public.service default 'whatsapp'::public.service not null,
  name text not null,
  -- Template já aprovado na Meta. Guardado por nome e idioma, e não por
  -- referência, porque o catálogo de templates vive lá e não aqui.
  template_name text not null,
  template_language text not null,
  -- A categoria decide a regra do jogo. Só "marketing" está sujeito ao limite
  -- por usuário que a Meta aplica somando todas as empresas — e é só nele que o
  -- descadastro precisa ser respeitado. Utility e authentication passam por
  -- fora disso.
  template_category text not null,
  -- De onde sai cada variável do template, por posição.
  variables jsonb default '{}'::jsonb not null,
  -- Filtro do público, aplicado sobre contacts/contacts_addresses na hora de
  -- materializar.
  audience jsonb default '{}'::jsonb not null,
  status public.campaign_status default 'draft'::public.campaign_status not null,
  -- Mensagens por segundo. O teto da Meta é 80 para conta comum, mas o padrão
  -- aqui é bem menor de propósito: encostar no limite é como se descobre que
  -- ele existe, e o preço de descobrir é `130429` seguido de queda na nota de
  -- qualidade. Quem quiser correr mais sobe na mão, olhando a saúde do número.
  throughput_mps integer default 20 not null,
  scheduled_at timestamp with time zone,
  started_at timestamp with time zone,
  completed_at timestamp with time zone,
  created_by uuid,
  extra jsonb default '{}'::jsonb not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

alter table only public.campaigns
add constraint campaigns_pkey
primary key (id);

alter table only public.campaigns
add constraint campaigns_organization_id_fkey
foreign key (organization_id)
references public.organizations(id)
on delete cascade;

-- Quem criou some, a campanha fica: o histórico de disparo é da organização, e
-- desligar uma pessoa não pode apagar o registro do que foi enviado.
alter table only public.campaigns
add constraint campaigns_created_by_fkey
foreign key (created_by)
references auth.users(id)
on delete set null;

alter table only public.campaigns
add constraint campaigns_throughput_mps_check
check (throughput_mps between 1 and 80);

alter table only public.campaigns
add constraint campaigns_template_category_check
check (
  template_category in ('marketing', 'utility', 'authentication')
);

create index campaigns_organization_id_idx
on public.campaigns
using btree (organization_id);

-- A fila pergunta, a cada rodada, quais campanhas de um número estão correndo.
-- Índice parcial porque a resposta é quase sempre "nenhuma": campanha em
-- andamento é o estado raro, e o que se paga aqui é por linha viva, não por
-- linha arquivada.
create index campaigns_running_idx
on public.campaigns
using btree (organization_address)
where status = 'running'::public.campaign_status;

create trigger set_updated_at
before update
on public.campaigns
for each row
execute function public.moddatetime('updated_at');

create trigger set_extra
before update
on public.campaigns
for each row
execute function public.merge_update('extra');
