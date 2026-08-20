-- # As credenciais do gateway de pagamento
--
-- Uma linha por organização: as chaves que a loja gerou no painel da AmploPay
-- e o token com que ela assina os postbacks.
--
-- ## Por que não em `organizations.extra`
--
-- Seria uma linha de JSON e nenhuma migração. Mas `extra` é lido por qualquer
-- membro da organização, e sai inteiro em toda consulta que traz a loja — a
-- tela de configurações, a lista de conversas, o assistente. A chave secreta
-- de pagamento apareceria em resposta de API que ninguém pediu, e um dia numa
-- captura de tela de suporte.
--
-- Tabela à parte é o que permite tratá-la como segredo de verdade, e é o que
-- as permissões de coluna abaixo fazem.
--
-- ## O que a loja perde, e por que está certo
--
-- A chave secreta é gravável e NÃO é legível. Quem cadastrou não consegue vê-la
-- de novo — nem o dono, nem o suporte, nem o painel. Se esquecer, gera outra na
-- AmploPay e cola por cima.
--
-- É o mesmo contrato de uma senha, e é o único que sobrevive a um vazamento de
-- token de acesso: quem roubar a sessão de um funcionário não leva a chave que
-- movimenta o dinheiro da loja. - 2026/08/19

create table if not exists public.gateway_credenciais (
  organization_id uuid primary key
    references public.organizations (id) on delete cascade,

  -- Qual adaptador atende esta loja. Hoje só existe um, e mesmo assim o campo
  -- fica: sem ele, trocar de gateway vira uma migração de dados em vez de uma
  -- troca de texto.
  provedor text not null default 'amplopay',

  chave_publica text not null,
  chave_secreta text not null,

  -- O `token` que a AmploPay manda DENTRO do corpo do postback. É o que prova
  -- que o aviso de "foi pago" veio mesmo dela — a URL do webhook não é segredo,
  -- ela aparece no painel do gateway, em prints e em conversa de suporte.
  segredo_webhook text,

  -- Desligar sem apagar. Uma loja que suspende o gateway por um mês não deveria
  -- ter de cadastrar as chaves outra vez para voltar.
  ativo boolean not null default true,

  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

comment on table public.gateway_credenciais is
  'Chaves do gateway de pagamento, uma linha por organização. As colunas de segredo são graváveis e não legíveis.';

comment on column public.gateway_credenciais.chave_secreta is
  'Gravável, nunca legível: o SELECT desta coluna é revogado de authenticated e anon.';
