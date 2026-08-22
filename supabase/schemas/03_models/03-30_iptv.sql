-- # O painel de IPTV, do lado de cá
--
-- Uma loja que vende assinatura de IPTV não vende o acesso: ela revende o de um
-- painel de fora — MEGABOX, PRIMELUX — que é quem cria o usuário, guarda a
-- senha e conta os dias. O que este produto faz é a conversa: pedir o teste,
-- mandar as credenciais, cobrar, e mandar de novo quando o cliente paga.
--
-- ## Isolado de propósito
--
-- Nada aqui é pré-requisito de nada. Uma barbearia nunca vê estas tabelas, e o
-- painel caindo não pode parar o atendimento — que é o produto. É a mesma
-- decisão do gateway de pagamento, pelo mesmo motivo.
--
-- ## Três níveis, e nenhum a mais
--
--   servidor   o painel de fora, com as credenciais dele
--   pacote     um plano dentro do painel: "Mensal Completo", "Anual"
--   app        o aplicativo em que o cliente assiste, e o texto que sai
--
-- A tentação é achatar em dois. Não dá: o mesmo pacote é entregue em quatro
-- aplicativos diferentes, e cada um pede um código de ativação diferente e uma
-- mensagem diferente. Achatado, a loja duplicaria o pacote uma vez por app e
-- teria quatro lugares para corrigir o preço. - 2026/08/22

create table if not exists public.iptv_servidores (
  id uuid default gen_random_uuid() not null,
  organization_id uuid not null,
  -- Como a loja chama: "MEGABOX".
  name text not null,
  -- Gerado do nome, para caber em URL e em chave de configuração.
  slug text not null,
  -- Onde o painel vive. As URLs de bot saem daqui quando não há uma própria.
  -- Opcional: o link do pacote é um endereço inteiro, e a raiz está dentro
  -- dele. Exigir as duas é pedir a mesma informação duas vezes.
  base_url text,
  -- O painel administrativo, que é outra URL na maioria dos provedores.
  painel_url text,
  /**
   * O TOKEN NÃO ESTÁ AQUI, e é a diferença que mais importa nesta tabela.
   *
   * A especificação que originou este arquivo guardava `token` e `user_id` em
   * colunas de texto. Aqui isso seria o mesmo erro que o token da Meta já
   * cometeu uma vez: qualquer membro da organização lê estas linhas pela
   * política de RLS abaixo, e o gatilho de webhook manda a linha inteira para
   * fora. Um token nessas condições é público para a equipe.
   *
   * Ele mora no Vault, com o nome derivado do id deste servidor, e só o
   * `service_role` lê — quem lê é a função de borda que fala com o painel. Ver
   * `iptv_token_secret_name` em `02-05_vault_secrets.sql`.
   */
  -- O identificador do revendedor dentro do painel. Não é segredo: sozinho ele
  -- não abre nada, e a tela precisa mostrar de qual conta se está falando.
  painel_user_id text,
  /**
   * Desligado é diferente de apagado.
   *
   * Um painel sai do ar, muda de dono, é trocado. Apagar levaria junto o
   * histórico de quem testou e quem comprou por ele — e é justamente esse
   * histórico que responde "de onde veio este cliente" seis meses depois.
   *
   * Toda criação de teste confere isto antes de falar com o painel: credencial
   * gerada num servidor fora do ar é um cliente recebendo usuário e senha que
   * não entram em lugar nenhum.
   */
  is_active boolean default true not null,
  -- Quantas horas dura um teste, quando o pacote não disser outra coisa.
  trial_horas integer default 2 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

alter table only public.iptv_servidores
drop constraint if exists iptv_servidores_pkey;

alter table only public.iptv_servidores
add constraint iptv_servidores_pkey primary key (id);

alter table only public.iptv_servidores
drop constraint if exists iptv_servidores_organization_id_fkey;

alter table only public.iptv_servidores
add constraint iptv_servidores_organization_id_fkey
foreign key (organization_id) references public.organizations(id)
on delete cascade;

-- Um slug por loja: é ele que aparece em URL e em configuração, e dois iguais
-- na mesma loja fariam a segunda configuração sobrescrever a primeira.
create unique index if not exists iptv_servidores_slug_idx
on public.iptv_servidores (organization_id, slug);

create table if not exists public.iptv_pacotes (
  id uuid default gen_random_uuid() not null,
  servidor_id uuid not null,
  -- "Mensal Completo", "Anual Premium".
  name text not null,
  /**
   * De onde as credenciais saem.
   *
   * Cai para a URL do servidor quando vazia. Existe porque cada pacote costuma
   * ter um endereço próprio no painel, e porque a loja que troca de pacote não
   * deveria ter de reconfigurar o servidor inteiro.
   */
  bot_url text,
  -- O pedaço final, quando a URL é montada a partir da do servidor.
  bot_path text,
  -- Quantas telas ao mesmo tempo. Vai na mensagem, e é o que mais gera
  -- pergunta depois da senha.
  telas integer default 1 not null,
  -- Quantas horas dura o teste deste pacote. Cai para a do servidor.
  duracao_horas integer,
  -- `teste` ou `pago`. Um pacote de teste não é vendido, e um pago não é dado.
  tipo text default 'teste' not null,
  is_active boolean default true not null,
  descricao text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

alter table only public.iptv_pacotes
drop constraint if exists iptv_pacotes_pkey;

alter table only public.iptv_pacotes
add constraint iptv_pacotes_pkey primary key (id);

alter table only public.iptv_pacotes
drop constraint if exists iptv_pacotes_servidor_id_fkey;

alter table only public.iptv_pacotes
add constraint iptv_pacotes_servidor_id_fkey
foreign key (servidor_id) references public.iptv_servidores(id)
on delete cascade;

alter table only public.iptv_pacotes
drop constraint if exists iptv_pacotes_tipo_check;

alter table only public.iptv_pacotes
add constraint iptv_pacotes_tipo_check check (tipo in ('teste', 'pago'));

create index if not exists iptv_pacotes_servidor_idx
on public.iptv_pacotes (servidor_id);

create table if not exists public.iptv_apps (
  id uuid default gen_random_uuid() not null,
  pacote_id uuid not null,
  -- "xciptv", "playsim", "vizzion". Minúsculo, porque vira chave de template.
  app text not null,
  is_enabled boolean default true not null,
  -- Como o cliente conhece: "PlaySim TV".
  display_name text,
  /**
   * O código de ativação deste app NESTE servidor.
   *
   * Não é do app nem do servidor sozinhos: é do par. O mesmo Vizzion tem um
   * código no MEGABOX e outro no PRIMELUX, e é por isso que ele mora aqui e
   * não numa tabela de aplicativos.
   *
   * Vazio é legítimo — vários apps não usam código.
   */
  codigo text,
  /**
   * O texto que sai para o cliente, com as credenciais dentro.
   *
   * Por APP, e não por loja: o que muda entre um XCIPTV e um Vizzion não é o
   * tom, são os campos — um pede código, outro pede DNS, outro pede a lista
   * M3U. Um texto só para todos obrigaria a mandar os campos de todos, e o
   * cliente receberia três linhas que não servem para ele.
   *
   * Vazio cai no texto padrão. Ver `iptv_texto` na função de borda.
   */
  texto text,
  -- Ordem na tela de escolher app. Quem tem quatro apps tem um preferido.
  ordem integer default 0 not null,
  /**
   * Os apps que ESTA loja usa de verdade.
   *
   * O catálogo se semeia sozinho com tudo que o painel oferece — nove, quinze,
   * às vezes mais — e quem atende vende dois ou três. Uma estrela resolve as
   * duas reclamações de uma vez: o favorito sobe, e o resto sai da frente.
   *
   * Sem nenhum favorito a lista fica inteira. É como ela nasce, e é o único
   * estado em que esconder algo seria esconder tudo.
   */
  favorito boolean default false not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

alter table only public.iptv_apps
drop constraint if exists iptv_apps_pkey;

alter table only public.iptv_apps
add constraint iptv_apps_pkey primary key (id);

alter table only public.iptv_apps
drop constraint if exists iptv_apps_pacote_id_fkey;

alter table only public.iptv_apps
add constraint iptv_apps_pacote_id_fkey
foreign key (pacote_id) references public.iptv_pacotes(id)
on delete cascade;

create unique index if not exists iptv_apps_pacote_app_idx
on public.iptv_apps (pacote_id, app);

-- # O teste que foi dado a alguém
--
-- Uma linha por credencial entregue. É o que responde três perguntas que
-- ninguém consegue responder olhando o painel de fora: quem pediu, quem
-- entregou, e se virou venda.
create table if not exists public.iptv_testes (
  id uuid default gen_random_uuid() not null,
  organization_id uuid not null,
  -- A conversa de onde saiu. Pode ser apagada, e por isso o telefone também
  -- fica repetido aqui — mesma decisão de `cobrancas`.
  conversation_id uuid,
  contact_id uuid,
  contact_address text not null,
  servidor_id uuid,
  -- Repetidos por cópia: o servidor pode ser renomeado ou apagado, e o teste
  -- de ontem tem de continuar dizendo por onde foi entregue.
  servidor_nome text,
  pacote_id uuid,
  pacote_nome text,
  app text,
  -- O que foi entregue. Guardado porque o cliente perde, e porque reenviar
  -- credenciais diferentes é o que mais gera "qual usuário eu uso?".
  username text not null,
  password text,
  codigo text,
  dns text,
  m3u_url text,
  duracao_horas integer default 2 not null,
  comeca_em timestamp with time zone default now() not null,
  expira_em timestamp with time zone not null,
  -- ativo | expirado | convertido | cancelado
  status text default 'ativo' not null,
  convertido_em timestamp with time zone,
  /**
   * Quem GEROU o teste.
   *
   * E é de propósito que a venda seja dele, e não de quem registrar o
   * pagamento depois. Num teste de IPTV o trabalho está em conseguir o teste e
   * acompanhar as duas horas seguintes; quem aperta "recebi" quando o Pix cai
   * pode ser outra pessoa, ou ninguém — o gateway avisa sozinho.
   *
   * Diverge do que `cobrancas.agent_id` faz hoje, onde a venda é de quem
   * registra. As duas regras estão certas para negócios diferentes, e é por
   * isso que esta coluna existe em vez de reaproveitar aquela.
   */
  vendido_por uuid,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

alter table only public.iptv_testes
drop constraint if exists iptv_testes_pkey;

alter table only public.iptv_testes
add constraint iptv_testes_pkey primary key (id);

alter table only public.iptv_testes
drop constraint if exists iptv_testes_organization_id_fkey;

alter table only public.iptv_testes
add constraint iptv_testes_organization_id_fkey
foreign key (organization_id) references public.organizations(id)
on delete cascade;

alter table only public.iptv_testes
drop constraint if exists iptv_testes_conversation_id_fkey;

-- `set null` e não `cascade`: apagar uma conversa não pode apagar a prova de
-- que alguém recebeu um teste. É a mesma regra de `cobrancas`.
alter table only public.iptv_testes
add constraint iptv_testes_conversation_id_fkey
foreign key (conversation_id) references public.conversations(id)
on delete set null;

alter table only public.iptv_testes
drop constraint if exists iptv_testes_vendido_por_fkey;

-- Demitir um atendente não apaga o histórico de vendas dele.
alter table only public.iptv_testes
add constraint iptv_testes_vendido_por_fkey
foreign key (vendido_por) references public.agents(id)
on delete set null;

alter table only public.iptv_testes
drop constraint if exists iptv_testes_status_check;

alter table only public.iptv_testes
add constraint iptv_testes_status_check
check (status in ('ativo', 'expirado', 'convertido', 'cancelado'));

/**
 * A pergunta do guarda de reuso: este telefone já tem teste vivo aqui?
 *
 * Feita antes de toda criação, e por isso indexada. Sem ela, o mesmo cliente
 * pedindo teste duas vezes em dez minutos consome dois créditos do painel e
 * recebe dois usuários diferentes — e aí não sabe qual usar.
 */
create index if not exists iptv_testes_ativos_idx
on public.iptv_testes (organization_id, contact_address, status)
where status = 'ativo';

create index if not exists iptv_testes_expira_idx
on public.iptv_testes (organization_id, expira_em)
where status = 'ativo';

create trigger set_updated_at
before update on public.iptv_servidores
for each row execute function public.moddatetime('updated_at');

create trigger set_updated_at
before update on public.iptv_pacotes
for each row execute function public.moddatetime('updated_at');

create trigger set_updated_at
before update on public.iptv_apps
for each row execute function public.moddatetime('updated_at');

create trigger set_updated_at
before update on public.iptv_testes
for each row execute function public.moddatetime('updated_at');
