-- As cobranças que a loja manda para os clientes dela.
--
-- Não confundir com `billing.invoices`, que é a mensalidade que a LOJA paga.
-- São dois dinheiros com dois donos: aqui é o corte de cabelo, lá é o produto.
-- Misturar os dois numa tabela só seria o começo de um relatório que ninguém
-- consegue ler.
--
-- ## Por que existe, se a mensagem já foi enviada
--
-- Sem registro, uma cobrança é só texto no meio da conversa: ninguém sabe o
-- que está em aberto, e "pagamento confirmado" não tem o que confirmar. Com
-- ele, a loja vê o que falta receber e o cliente recebe a confirmação sozinho
-- — seja porque o gateway avisou, seja porque alguém tocou em "recebi".
--
-- ## O que ela NÃO é
--
-- Não é nota fiscal e não é conciliação bancária. Guarda o que foi pedido, de
-- quem, quanto e se entrou. Quem precisa de mais que isso precisa de um
-- sistema financeiro, e este não é.

create table public.cobrancas (
  id uuid default gen_random_uuid() not null,
  organization_id uuid not null,
  conversation_id uuid not null,
  -- Repetido da conversa de propósito: a conversa pode ser apagada, e a
  -- cobrança de quem já pagou não pode sumir junto do histórico do caixa.
  contact_address text not null,
  /**
   * O que foi cobrado: [{ "nome": "Corte", "valor": 45 }].
   *
   * Uma cópia, e não uma referência ao catálogo. Preço muda, e a cobrança de
   * ontem tem de continuar dizendo o que foi cobrado ontem — é a mesma regra
   * que `appointments` já segue com o valor do serviço.
   */
  itens jsonb not null default '[]'::jsonb,
  valor numeric not null,
  status text not null default 'aberta',
  -- pix | amplopay | kirvano | kiwify | dinheiro | cartao
  metodo text,
  -- O id da transação no gateway, quando veio de um. É a trava contra o mesmo
  -- postback ser processado duas vezes.
  external_id text,
  -- Por quantos dias vale o que foi pago. Nulo em servico que nao vence.
  --
  -- Copiado do catalogo, e nao lido de la na hora de exibir: a validade do
  -- plano pode mudar amanha, e a assinatura vendida ontem continua valendo o
  -- que valia. Mesma razao de os itens serem copia.
  validade_dias integer,
  -- A data do pagamento mais a validade. Calculado no PAGAMENTO e nao no
  -- envio: o plano comeca a valer quando o dinheiro entra, e entre uma coisa
  -- e outra pode passar uma semana.
  vence_em timestamp with time zone,
  paga_em timestamp with time zone,
  /**
   * Quando o cliente foi avisado de que o pagamento entrou.
   *
   * ## Existe porque avisar FALHA em silêncio
   *
   * A confirmação sai de três lugares — o postback do gateway, o botão
   * "Confirmar" das cobranças abertas e o registro na mão — e nos três ela é
   * a última coisa a acontecer, de propósito: se o envio falhar, o pagamento
   * continua quitado. O dinheiro entrou, e esse é o fato.
   *
   * O preço disso é que o envio perdido não deixa rastro nenhum. O caixa
   * fecha certo, a cobrança aparece paga, e o cliente é o único que sabe que
   * ficou sem resposta — ele volta perguntando "recebeu?", que é exatamente
   * o que a confirmação existia para evitar.
   *
   * Com a marca, a pergunta "quem pagou e não foi avisado?" tem resposta, e
   * a tela consegue reenviar. Nulo em pagamento antigo e em cobrança aberta.
   */
  recibo_em timestamp with time zone,
  /**
   * De quem é esta venda.
   *
   * Existe para a comissão ter de quem contar: numa loja com atendentes, "a
   * loja faturou R$ 3.400" não responde quanto cada um trouxe, e é essa a
   * pergunta do fim do mês.
   *
   * Gravado no momento da cobrança, e não lido do dono da conversa na hora do
   * relatório: o dono pode mudar, o atendente pode sair, a conversa pode ser
   * apagada — e a venda de agosto tem de continuar sendo de quem a fez. É a
   * mesma regra pela qual `itens` é cópia e não referência ao catálogo.
   *
   * `on delete set null` e não `cascade`: demitir um atendente não pode apagar
   * o faturamento dele do caixa da loja. A venda continua, sem dono.
   *
   * Nulo é o normal do que já existia e do que entra por webhook de gateway:
   * ninguém atendeu, o cliente pagou sozinho pelo link.
   */
  agent_id uuid,
  /**
   * Onde o dinheiro entrou, quando quem anotou sabe dizer.
   *
   * `metodo` responde "pix"; uma loja com três chaves precisa saber em QUAL
   * — é o que separa conferir um extrato de conferir três. Guarda o rótulo
   * que a loja deu à chave ("Stone", "Nubank"), e não a chave: o rótulo é o
   * que a pessoa lê, e a chave pode ser trocada sem que o pagamento de ontem
   * deixe de ter entrado onde entrou.
   *
   * Nulo é o normal: dinheiro no balcão não tem conta, e o que vem por
   * gateway já se identifica pelo `metodo`.
   */
  conta text,
  /**
   * O que quem anotou quis deixar escrito.
   *
   * "Pagou metade agora e metade na sexta", "veio pelo irmão", "desconto
   * porque indicou dois". Nada disso cabe em `itens` nem em `metodo`, e sem
   * lugar para escrever a pessoa escreve na conversa — onde some para cima em
   * dois dias e não aparece em relatório nenhum.
   *
   * Livre de propósito. Um campo estruturado obrigaria a adivinhar quais são
   * os casos, e os casos são o balcão.
   */
  nota text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

alter table only public.cobrancas
add constraint cobrancas_pkey
primary key (id);

alter table only public.cobrancas
add constraint cobrancas_organization_id_fkey
foreign key (organization_id)
references public.organizations(id)
on delete cascade;

alter table only public.cobrancas
add constraint cobrancas_conversation_id_fkey
foreign key (conversation_id)
references public.conversations(id)
on delete cascade;

alter table only public.cobrancas
add constraint cobrancas_agent_id_fkey
foreign key (agent_id)
references public.agents(id)
on delete set null;

alter table only public.cobrancas
add constraint cobrancas_status_check
check (status in ('aberta', 'paga', 'cancelada'));

-- Um postback reenviado não vira segunda cobrança paga. Mesma trava que
-- `billing.payments` tem, pelo mesmo motivo.
create unique index cobrancas_external_id_idx
on public.cobrancas (metodo, external_id)
where external_id is not null;

create index cobrancas_conversation_id_idx
on public.cobrancas (conversation_id);

-- A pergunta que a tela faz o tempo todo: o que esta loja tem em aberto.
create index cobrancas_abertas_idx
on public.cobrancas (organization_id, status)
where status = 'aberta';

create trigger set_updated_at
before update
on public.cobrancas
for each row
execute function public.moddatetime('updated_at');
