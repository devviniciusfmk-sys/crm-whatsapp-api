-- As quatro operações da loja de números, e a regra de corrida/idempotência
-- num lugar só. Mesmo raciocínio de `04-20_cobrancas.sql`: a mesma conta
-- implementada duas vezes é como uma dar um resultado e a outra dar outro
-- para o mesmo número.

/**
 * Reserva um número para uma organização — o instante entre "comprar" e o
 * pagamento cair.
 *
 * ## A trava de corrida
 *
 * Dois compradores podem clicar em "comprar" no mesmo número ao mesmo
 * segundo. O `update ... where status = 'disponivel'` é a trava: só uma das
 * duas transações concorrentes encontra a linha ainda `disponivel` e consegue
 * o `update`; a outra roda depois, já com o status trocado, e não afeta
 * nenhuma linha. É a mesma ideia do `where status in ('aberta', 'parcial')`
 * de `receber_parcial` — a condição de corrida é resolvida pela cláusula
 * `where` do próprio update, não por uma checagem separada antes dele, que
 * teria uma janela entre ler e escrever onde o outro comprador passa.
 *
 * Zero linhas afetadas é o sinal de que a corrida foi perdida (ou de que o
 * número já não existe, ou já estava vendido) — e vira erro, porque não há
 * um "pedido antigo" para devolver como em `quitar_cobranca`: aqui ainda não
 * existe pedido nenhum até este ponto.
 *
 * `preco` é lido AQUI, dentro do mesmo update que trava a linha, e copiado
 * para `loja_pedidos.valor` — não é uma segunda consulta separada, que
 * correria o risco de ler um preço diferente do que a reserva de fato
 * travou. - 2026/08/26
 */
create or replace function public.reservar_numero_loja(
  _numero uuid,
  _organization_id uuid,
  _user_id uuid default null
) returns public.loja_pedidos
language plpgsql
security definer
set search_path to ''
as $$
declare
  _preco numeric;
  _pedido public.loja_pedidos%rowtype;
begin
  update public.loja_numeros
  set status = 'reservado',
      atualizado_em = now()
  where id = _numero
    and status = 'disponivel'
  returning preco into _preco;

  if not found then
    raise exception 'número não está mais disponível';
  end if;

  insert into public.loja_pedidos (
    organization_id, numero_id, comprador_user_id, valor, status
  ) values (
    _organization_id, _numero, _user_id, _preco, 'aberto'
  )
  returning * into _pedido;

  return _pedido;
end;
$$;

-- Chamada só pela função de borda que faz o checkout, com a chave de
-- serviço — e não por `anon`/`authenticated` diretamente: quem decide que a
-- organização pode comprar (assinatura ativa, limite de números, etc.) é a
-- borda, ANTES de chamar isto. Uma política de RLS aqui checaria só "a
-- organização existe", que não é a pergunta que importa.
revoke execute on function public.reservar_numero_loja(uuid, uuid, uuid)
from public, anon, authenticated;

grant execute on function public.reservar_numero_loja(uuid, uuid, uuid)
to service_role;

/**
 * Marca o pedido como pago e conecta o número a quem pagou — ou NADA, se já
 * tivesse sido processado.
 *
 * Mesmo contrato de idempotência de `quitar_cobranca`: `strict` no select
 * porque pedido que não existe é erro de quem chamou (o webhook mandando um
 * id errado), e devolver nulo quando já está `pago`/`conectado`/`cancelado`
 * é o caminho normal do reenvio — todo gateway manda o mesmo postback de
 * novo quando não recebe 200 a tempo, e processar duas vezes venderia o
 * mesmo número duas vezes ou reembolsaria sozinho quem já tinha pago.
 *
 * ## Por que ela também mexe em `loja_numeros`
 *
 * Pagar o pedido e vender o número são o mesmo evento visto de duas tabelas:
 * o pedido existe para o histórico e o número existe para o catálogo, mas os
 * dois têm de mudar juntos, na mesma transação — se só o pedido virasse
 * `pago` e o número continuasse `reservado`, o admin de conexão não teria
 * como saber que aquele número já tem dono pago, e o catálogo mostraria como
 * reservado um número que na verdade já foi vendido.
 */
create or replace function public.quitar_pedido_loja(
  _pedido uuid,
  _metodo text default null,
  _external_id text default null
) returns public.loja_pedidos
language plpgsql
security definer
set search_path to ''
as $$
declare
  _p public.loja_pedidos%rowtype;
begin
  select * into strict _p from public.loja_pedidos where id = _pedido;

  if _p.status in ('pago', 'conectado', 'cancelado') then
    return null;
  end if;

  update public.loja_pedidos
  set status = 'pago',
      pago_em = now(),
      metodo = coalesce(_metodo, metodo),
      external_id = coalesce(_external_id, external_id)
  where id = _pedido
  returning * into _p;

  update public.loja_numeros
  set status = 'vendido',
      organization_id = _p.organization_id,
      atualizado_em = now()
  where id = _p.numero_id;

  return _p;
end;
$$;

-- Chamada pelo webhook de pagamento, com a chave de serviço. Sem caminho de
-- leitura para `anon`/`authenticated` nesta tabela (ver `05-31_loja_rls.sql`),
-- então não há razão para conceder execução a eles aqui.
revoke execute on function public.quitar_pedido_loja(uuid, text, text)
from public, anon, authenticated;

grant execute on function public.quitar_pedido_loja(uuid, text, text)
to service_role;

/**
 * Cancela uma reserva/pedido em aberto e devolve o número ao catálogo.
 *
 * Só mexe em pedido `aberto` — e é NO-OP, não erro, em qualquer outro status.
 * Essa mansidão é de propósito: esta função tem dois chamadores, uma ação de
 * admin ("cancelar esta reserva") e a varredura de expiração logo abaixo, e
 * os dois podem chegar aqui depois que o pedido já saiu de `aberto` por outro
 * caminho — o comprador pagou no instante em que o admin ia cancelar, ou a
 * varredura roda sobre um pedido que acabou de ser pago um segundo antes.
 * Um `raise exception` nesse cruzamento derrubaria a varredura inteira por
 * causa de UM pedido que, na prática, não precisava de nenhuma ação.
 *
 * `organization_id = null` no número junto com o `status = 'disponivel'`:
 * a reserva nunca virou venda de verdade, então não sobra dono nenhum para
 * lembrar — diferente de `quitar_pedido_loja`, que atribui a organização
 * porque ali o pagamento de fato aconteceu.
 */
create or replace function public.cancelar_pedido_loja(
  _pedido uuid
) returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
  _numero_id uuid;
begin
  update public.loja_pedidos
  set status = 'cancelado'
  where id = _pedido
    and status = 'aberto'
  returning numero_id into _numero_id;

  if not found then
    return;
  end if;

  update public.loja_numeros
  set status = 'disponivel',
      organization_id = null,
      atualizado_em = now()
  where id = _numero_id;
end;
$$;

revoke execute on function public.cancelar_pedido_loja(uuid)
from public, anon, authenticated;

grant execute on function public.cancelar_pedido_loja(uuid)
to service_role;

/**
 * Libera reservas abandonadas: quem clicou em "comprar" e nunca pagou não
 * pode segurar o número para sempre.
 *
 * Sem isto, `loja_pedidos_numero_ativo_idx` vira uma trava permanente contra
 * o próprio negócio — um comprador que desiste no meio do checkout deixaria
 * o número preso em `reservado`, inelegível para venda, e ninguém mais
 * conseguiria comprá-lo. `_minutos` é a janela de tolerância: tempo o
 * bastante para terminar um Pix, curto o bastante para o número voltar ao
 * catálogo no mesmo dia.
 *
 * Reaproveita `cancelar_pedido_loja` em vez de repetir a lógica de devolver o
 * número: são o mesmo desfecho — reserva não virou venda —, só que um é
 * decidido por uma pessoa e o outro pelo relógio. Duas implementações da
 * mesma regra de devolução é como uma delas esquecer de zerar
 * `organization_id` e a outra não.
 *
 * Pura SQL/plpgsql, sem chamada de rede: por isso o cron job em
 * `20260826120000_cron_da_loja.sql` chama esta função direto, sem passar por
 * uma função de borda.
 */
create or replace function public.expirar_reservas_loja(
  _minutos int default 30
) returns int
language plpgsql
security definer
set search_path to ''
as $$
declare
  _id uuid;
  _quantos int := 0;
begin
  for _id in
    select id
    from public.loja_pedidos
    where status = 'aberto'
      and criado_em < now() - (_minutos || ' minutes')::interval
  loop
    perform public.cancelar_pedido_loja(_id);
    _quantos := _quantos + 1;
  end loop;

  return _quantos;
end;
$$;

-- `service_role` para uso geral, e sem `revoke` de `public` — mesmo padrão de
-- `billing.emitir_faturas_do_mes`, que também não revoga o privilégio padrão
-- de execução concedido a `public` por `create function`. É esse privilégio
-- padrão, e não uma concessão explícita, que deixa o pg_cron (que roda como
-- `postgres`) chamar esta função no `cron.schedule` do passo seguinte.
grant execute on function public.expirar_reservas_loja(int)
to service_role;
