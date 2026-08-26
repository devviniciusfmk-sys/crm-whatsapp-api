-- O registro da venda de um número da loja, e sua trilha de auditoria.
-- Modelada em cima de `cobrancas`: o que foi combinado, quanto, e se entrou.
--
-- `valor` é COPIADO de `loja_numeros.preco` no momento da reserva, e não lido
-- de lá na hora de exibir ou de conferir o pagamento — mesma regra que
-- `cobrancas.itens` já segue com o catálogo de serviços. O preço do número
-- pode mudar depois (a plataforma reajusta, faz promoção), e o pedido de
-- ontem tem de continuar dizendo o que foi cobrado ontem. Reescrever o
-- histórico porque o preço mudou seria mentir sobre quanto aquele comprador
-- efetivamente pagou.
--
-- ## Os dois índices únicos
--
-- `loja_pedidos_external_id_idx` é a mesma trava contra reenvio de webhook
-- que `cobrancas_external_id_idx` já tem: o gateway reenvia o postback quando
-- não recebe 200 rápido o bastante, e sem essa trava o mesmo pagamento
-- criaria duas confirmações.
--
-- `loja_pedidos_numero_ativo_idx` é diferente — não é sobre reenvio, é sobre
-- corrida. Garante que só existe UM pedido vivo (`aberto` ou `pago`) por
-- número ao mesmo tempo, e é o mecanismo que impede vender o mesmo número
-- para dois compradores que clicam em "comprar" no mesmo instante: o segundo
-- insert esbarra no índice antes de conseguir criar um segundo pedido para o
-- mesmo número já reservado. A trava de verdade contra a corrida é o
-- `update ... where status = 'disponivel'` em `reservar_numero_loja` — este
-- índice é o cinto e suspensório que garante que a tabela nunca guarda dois
-- pedidos vivos para o mesmo número, mesmo que algum caminho futuro insira
-- direto sem passar por aquela função.
create table public.loja_pedidos (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  numero_id uuid not null references public.loja_numeros(id),
  comprador_user_id uuid,
  valor numeric not null,
  status text not null default 'aberto'
    check (status in ('aberto','pago','conectado','cancelado')),
  metodo text,
  codigo_pix text,
  external_id text,
  conectado_por uuid,
  criado_em timestamptz not null default now(),
  pago_em timestamptz,
  conectado_em timestamptz
);

create unique index loja_pedidos_external_id_idx
  on public.loja_pedidos (metodo, external_id) where external_id is not null;

create unique index loja_pedidos_numero_ativo_idx
  on public.loja_pedidos (numero_id) where status in ('aberto', 'pago');

create index loja_pedidos_organization_id_idx
  on public.loja_pedidos (organization_id);
