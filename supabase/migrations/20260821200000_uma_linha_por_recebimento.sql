-- Uma linha por vez que o dinheiro entrou.
--
-- `valor_pago` diz QUANTO já entrou de uma cobrança; ele não diz quando, e
-- é o quando que o fechamento do mês precisa. Com metade hoje e metade
-- sexta, um campo de data só faria os dois pedaços contarem juntos no dia em
-- que a conta fechou — e num virar de mês isso paga comissão sobre dinheiro
-- do mês passado, além de fechar o caixa de hoje sem o dinheiro de hoje.
--
-- Quem insere são as duas funções abaixo, e só elas. `quitar_cobranca` lança
-- o que FALTAVA, e não o valor cheio: quem deu entrada de R$ 50 numa conta de
-- R$ 100 está trazendo R$ 50.

-- Cada vez que dinheiro entrou.
--
-- ## Por que uma tabela, e não mais uma coluna
--
-- "Metade hoje, metade sexta" é uma cobrança e DOIS recebimentos, e a
-- diferença aparece na hora de somar o mês: com um só campo de data, os R$ 50
-- de hoje e os R$ 50 de sexta contam juntos no dia em que a conta fechou. Se
-- os dois caírem em meses diferentes, o fechamento do mês paga comissão sobre
-- dinheiro que entrou no mês passado — e o caixa de hoje fecha sem o dinheiro
-- que entrou hoje.
--
-- Uma linha por movimento resolve isso porque é o que de fato aconteceu: dois
-- movimentos, duas datas, dois métodos.
--
-- ## Ninguém escreve aqui direto
--
-- Só `quitar_cobranca` e `receber_parcial` inserem, e as duas mantêm
-- `cobrancas.valor_pago` em dia junto. Duas portas para o mesmo dinheiro
-- seriam dois totais discordando.
create table if not exists public.cobranca_recebimentos (
  id uuid default gen_random_uuid() not null,
  cobranca_id uuid not null,
  -- Repetida da cobrança: o caixa pergunta por organização, e sem ela toda
  -- soma do mês precisaria de uma junção.
  organization_id uuid not null,
  valor numeric not null,
  -- dinheiro | pix | cartao | transferencia | <gateway>
  metodo text,
  -- Em qual conta caiu. Ver `cobrancas.conta`.
  conta text,
  nota text,
  -- Quem recebeu. É o que a comissão soma no fim do mês, e por movimento:
  -- a entrada pode ser de um atendente e o resto de outro.
  agent_id uuid,
  recebido_em timestamp with time zone default now() not null,
  created_at timestamp with time zone default now() not null
);

alter table only public.cobranca_recebimentos
drop constraint if exists cobranca_recebimentos_pkey;

alter table only public.cobranca_recebimentos
add constraint cobranca_recebimentos_pkey primary key (id);

alter table only public.cobranca_recebimentos
drop constraint if exists cobranca_recebimentos_cobranca_id_fkey;

-- `cascade`: recebimento sem cobrança não diz de que era.
alter table only public.cobranca_recebimentos
add constraint cobranca_recebimentos_cobranca_id_fkey
foreign key (cobranca_id) references public.cobrancas(id) on delete cascade;

alter table only public.cobranca_recebimentos
drop constraint if exists cobranca_recebimentos_organization_id_fkey;

alter table only public.cobranca_recebimentos
add constraint cobranca_recebimentos_organization_id_fkey
foreign key (organization_id) references public.organizations(id)
on delete cascade;

alter table only public.cobranca_recebimentos
drop constraint if exists cobranca_recebimentos_agent_id_fkey;

-- Demitir um atendente não apaga o faturamento dele do caixa da loja.
alter table only public.cobranca_recebimentos
add constraint cobranca_recebimentos_agent_id_fkey
foreign key (agent_id) references public.agents(id) on delete set null;

-- A pergunta do fechamento: o que entrou nesta loja neste mês.
create index if not exists cobranca_recebimentos_mes_idx
on public.cobranca_recebimentos (organization_id, recebido_em);

create index if not exists cobranca_recebimentos_cobranca_idx
on public.cobranca_recebimentos (cobranca_id);

alter table public.cobranca_recebimentos enable row level security;

drop policy if exists cobranca_recebimentos_da_organizacao
on public.cobranca_recebimentos;

-- Quem enxerga a cobrança enxerga os recebimentos dela. A regra de quem
-- pertence a qual organização já está resolvida uma vez, em `cobrancas`;
-- repeti-la aqui seria a segunda definição de quem pode ver dinheiro.
create policy cobranca_recebimentos_da_organizacao
on public.cobranca_recebimentos
for all
to authenticated
using (
  exists (
    select 1 from public.cobrancas c
    where c.id = cobranca_recebimentos.cobranca_id
  )
)
with check (
  exists (
    select 1 from public.cobrancas c
    where c.id = cobranca_recebimentos.cobranca_id
  )
);

-- O que já estava pago vira um recebimento com a data do pagamento. Sem
-- isto, o caixa e a comissão do mês corrente ficariam vazios no dia da
-- migração — a loja abriria o fechamento e veria zero.
insert into public.cobranca_recebimentos (
  cobranca_id, organization_id, valor, metodo, conta, agent_id, recebido_em
)
select c.id, c.organization_id, c.valor, c.metodo, c.conta, c.agent_id,
       coalesce(c.paga_em, c.updated_at)
from public.cobrancas c
where c.status = 'paga'
  and not exists (
    select 1 from public.cobranca_recebimentos r where r.cobranca_id = c.id
  );

-- As duas funções ganham `_agente`, e as versões antigas TÊM de sair: um
-- `create or replace` com outra assinatura cria uma sobrecarga, e quem
-- chamasse com os argumentos de antes continuaria caindo no corpo velho —
-- que não lança recebimento nenhum.
drop function if exists public.quitar_cobranca(uuid, text, text);
drop function if exists public.receber_parcial(
  uuid, numeric, text, text, text, timestamptz
);

/**
 * Marca a cobrança como paga e devolve a linha — ou NADA, se já estava paga.
 *
 * Devolver nulo na segunda chamada é o que impede o cliente de receber duas
 * confirmações pela mesma compra: todo gateway reenvia o postback quando não
 * recebe 200 rápido o bastante, e quem chama precisa saber que não fez nada.
 *
 * ## Ela também registra o MOVIMENTO
 *
 * O que entra aqui é o que faltava — `valor - valor_pago` —, e não o valor
 * cheio: quem já tinha dado entrada de R$ 50 numa conta de R$ 100 está
 * trazendo R$ 50, e lançar R$ 100 faria o caixa do dia contar o dobro.
 *
 * Dentro daqui e não de quem chama, porque são três chamadores — o postback
 * do gateway, a tela, e `receber_parcial` — e o movimento tem de existir nos
 * três. Um deles esquecendo seria dinheiro fora do caixa sem nada indicando.
 * - 2026/08/21
 */
create or replace function public.quitar_cobranca(
  _cobranca uuid,
  _metodo text default null,
  _external_id text default null,
  _agente uuid default null
) returns public.cobrancas
language plpgsql
security definer
set search_path to ''
as $$
declare
  _c public.cobrancas%rowtype;
  _falta numeric;
begin
  -- `strict` de propósito: cobrança que não existe é erro de quem chamou, e
  -- merece estourar. Já paga é o caso normal do reenvio, e devolve nulo.
  select * into strict _c from public.cobrancas where id = _cobranca;

  if _c.status = 'paga' then
    return null;
  end if;

  _falta := _c.valor - coalesce(_c.valor_pago, 0);

  update public.cobrancas
  set status = 'paga',
      paga_em = now(),
      valor_pago = _c.valor,
      vence_em = public.vencimento_da_cobranca(_cobranca, now()),
      metodo = coalesce(_metodo, metodo),
      external_id = coalesce(_external_id, external_id)
  where id = _cobranca
  returning * into _c;

  -- Zero quando `receber_parcial` já lançou o último pedaço e só depois
  -- chamou aqui para fechar. Lançar um movimento de R$ 0,00 encheria o caixa
  -- de linhas que não são dinheiro.
  if _falta > 0 then
    insert into public.cobranca_recebimentos (
      cobranca_id, organization_id, valor, metodo, conta, nota, agent_id
    ) values (
      _c.id, _c.organization_id, _falta, _c.metodo, _c.conta, null,
      coalesce(_agente, _c.agent_id)
    );
  end if;

  return _c;
end;
$$;

grant execute on function public.quitar_cobranca(uuid, text, text, uuid)
to anon, authenticated, service_role;

/**
 * Recebe uma PARTE do que foi combinado — ou o resto dela.
 *
 * ## Por que no banco, e não na tela
 *
 * A pergunta "já completou?" é uma soma comparada com um total, e é o tipo
 * de conta que parece boba até existir em dois lugares. A tela somaria o que
 * está na memória dela; se dois atendentes lançarem a entrada e o resto ao
 * mesmo tempo, os dois leem o mesmo `valor_pago` antigo e a cobrança fecha
 * com metade do dinheiro. Aqui a soma é feita sobre a linha, no update.
 *
 * ## Completou? É `quitar_cobranca` quem resolve
 *
 * E não um `status = 'paga'` escrito aqui. Quem calcula o vencimento é
 * `vencimento_da_cobranca`, somando em cima do prazo que o cliente já tinha,
 * e é a mesma função que o webhook do gateway usa. Um segundo lugar
 * escrevendo `paga` seria um segundo lugar decidindo até quando o acesso
 * vale.
 *
 * ## A anotação ACUMULA
 *
 * Duas entradas são duas histórias — "entrada no dinheiro", "quitou no Pix"
 * — e a segunda não pode apagar a primeira. Já o método e a conta são
 * sobrescritos de propósito: eles respondem "como este cliente paga", que é
 * uma pergunta sobre a ÚLTIMA vez, do mesmo jeito que `contact_overview` já
 * trata `metodo_assinatura`. - 2026/08/21
 */
create or replace function public.receber_parcial(
  _cobranca uuid,
  _valor numeric,
  _metodo text default null,
  _conta text default null,
  _nota text default null,
  _combinado_para timestamptz default null,
  _agente uuid default null
) returns public.cobrancas
language plpgsql
security definer
set search_path to ''
as $$
declare
  _c public.cobrancas%rowtype;
begin
  if _valor is null or _valor <= 0 then
    raise exception 'valor recebido tem de ser maior que zero';
  end if;

  update public.cobrancas
  set valor_pago = coalesce(valor_pago, 0) + _valor,
      metodo = coalesce(_metodo, metodo),
      conta = coalesce(_conta, conta),
      nota = case
        when _nota is null then nota
        when nota is null or nota = '' then _nota
        else nota || ' · ' || _nota
      end,
      combinado_para = _combinado_para,
      status = 'parcial'
  where id = _cobranca
    and status in ('aberta', 'parcial')
  returning * into _c;

  -- Cobrança que não existe, ou já paga, ou cancelada. Nulo em vez de erro,
  -- pela mesma razão de `quitar_cobranca`: quem chama duas vezes é a rede.
  if _c.id is null then
    return null;
  end if;

  -- O movimento, com a data de HOJE. É o que faz os R$ 50 de hoje contarem
  -- no caixa de hoje, e não no dia em que a conta terminar de fechar.
  insert into public.cobranca_recebimentos (
    cobranca_id, organization_id, valor, metodo, conta, nota, agent_id
  ) values (
    _c.id, _c.organization_id, _valor, _metodo, _conta, _nota,
    coalesce(_agente, _c.agent_id)
  );

  if _c.valor_pago >= _c.valor then
    -- Completou. O combinado deixa de existir junto com a dívida: uma data
    -- de cobrar quem já pagou é alguém sendo incomodado à toa.
    update public.cobrancas set combinado_para = null where id = _cobranca;

    return public.quitar_cobranca(_cobranca, _metodo, null, _agente);
  end if;

  return _c;
end;
$$;

grant execute on function public.receber_parcial(
  uuid, numeric, text, text, text, timestamptz, uuid
) to anon, authenticated, service_role;
