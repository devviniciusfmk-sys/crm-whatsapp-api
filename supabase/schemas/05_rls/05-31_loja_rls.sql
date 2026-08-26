alter table public.loja_numeros enable row level security;

-- Zero políticas, de propósito. Nada nesta tabela é seguro para um cliente
-- ler direto: `organization_id` fica nulo até o número ser vendido, então não
-- existe uma organização para checar com `get_authorized_orgs` enquanto o
-- número está no catálogo — e depois de vendido, quem monta o que o
-- comprador vê é uma função de borda, campo a campo, com a chave de serviço
-- (mesma ideia de `pagamentos/checkout.ts`'s `lerCheckout`, que também nunca
-- faz `select *` na tabela de origem). Só `service_role` alcança esta tabela.

alter table public.loja_pedidos enable row level security;

create policy "owners see their orgs loja pedidos"
on public.loja_pedidos
for select
to authenticated
using (
  organization_id in (
    select public.get_authorized_orgs('owner')
  )
);

-- `owner`, e não `member`: isto é dinheiro que a organização gasta, mesma
-- camada de `billing.invoices` e `gateway_credenciais` — não é operação do
-- dia a dia que qualquer atendente precise ver.
--
-- Sem política de insert/update/delete: toda escrita nesta tabela — a
-- reserva, o pagamento, o cancelamento, e também a transição final para
-- `conectado`, feita direto pela função de borda de entrega — vem de código
-- que usa a chave de serviço, que ignora RLS por definição. `aberto` e `pago`
-- só existem passando por `reservar_numero_loja` / `quitar_pedido_loja` /
-- `cancelar_pedido_loja` acima; uma política de escrita aqui seria um segundo
-- caminho para o mesmo dado, e o primeiro sintoma seria um pedido criado sem
-- passar pela trava de corrida de `reservar_numero_loja`.
