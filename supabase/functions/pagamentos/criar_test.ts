import { assertEquals, assertRejects } from "jsr:@std/assert";
import {
  criarPixAmploPay,
  ErroDoGateway,
  telefoneBR,
  testarAmploPay,
} from "./criar.ts";

/**
 * A criação da cobrança testada sem tocar no gateway.
 *
 * O `fetch` é trocado por um que grava o que foi mandado. É o único jeito de
 * afirmar coisas sobre a REQUISIÇÃO — e é na requisição que moram os erros
 * caros: valor na unidade errada cobra cem vezes menos, telefone no formato
 * errado vira um DDD que não existe, referência sem prefixo faz o pagamento do
 * cliente cair na fatura da loja.
 *
 * Nenhum destes testes prova que a AmploPay aceita o que mandamos. Isso só o
 * primeiro Pix de verdade prova. O que eles provam é que o que mandamos é o
 * que a documentação deles descreve — e isso é o que está sob nosso controle.
 */

const CREDENCIAIS = { publica: "pub", secreta: "sec" };

const PAGADOR = {
  nome: "João da Silva",
  email: "joao@gmail.com",
  telefone: "5511999998888",
  documento: "123.456.789-00",
};

/** Um `fetch` que responde o que mandarem e guarda o que recebeu. */
function fetchDeMentira(resposta: unknown, status = 201) {
  const gravado: { url?: string; headers?: Headers; corpo?: any } = {};

  const buscar = ((url: string, init: RequestInit = {}) => {
    gravado.url = url;
    gravado.headers = new Headers(init.headers);
    /* Sem corpo é o caso do GET que confere a credencial. A primeira versão
     * fazia `JSON.parse(String(undefined))` e estourava — quatro testes
     * falhando por causa do arreio, não do código testado. */
    gravado.corpo = init.body ? JSON.parse(String(init.body)) : undefined;

    return Promise.resolve(
      new Response(JSON.stringify(resposta), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as unknown as typeof fetch;

  return { buscar, gravado };
}

const CRIADA = {
  transactionId: "clwuwmn4i0007emp9lgn66u1h",
  status: "OK",
  order: { id: "cm92", url: "https://app.amplopay.com/order/cm92" },
  pix: { code: "00020101021126530014BR.GOV.BCB.PIX...6304A8E3", image: "https://q/r", base64: "" },
};

Deno.test("manda o valor em reais, e não em centavos", async () => {
  const { buscar, gravado } = fetchDeMentira(CRIADA);

  await criarPixAmploPay(
    { referencia: "cob:abc", valor: 97.5, pagador: PAGADOR },
    CREDENCIAIS,
    buscar,
  );

  // 97.5 e não 9750. O gateway lê o número como está.
  assertEquals(gravado.corpo.amount, 97.5);
});

Deno.test("a referência vai inteira, com o prefixo", async () => {
  const { buscar, gravado } = fetchDeMentira(CRIADA);

  await criarPixAmploPay(
    { referencia: "cob:78b286f3", valor: 40, pagador: PAGADOR },
    CREDENCIAIS,
    buscar,
  );

  // É o prefixo que, na volta, separa o dinheiro do cliente da mensalidade da
  // loja. Perder aqui é errar o destino de um pagamento.
  assertEquals(gravado.corpo.identifier, "cob:78b286f3");
});

Deno.test("autentica com as duas chaves nos cabeçalhos", async () => {
  const { buscar, gravado } = fetchDeMentira(CRIADA);

  await criarPixAmploPay(
    { referencia: "cob:a", valor: 10, pagador: PAGADOR },
    CREDENCIAIS,
    buscar,
  );

  assertEquals(gravado.headers?.get("x-public-key"), "pub");
  assertEquals(gravado.headers?.get("x-secret-key"), "sec");
  assertEquals(gravado.url, "https://app.amplopay.com/api/v1/gateway/pix/receive");
});

Deno.test("o telefone perde o 55 e ganha o formato brasileiro", () => {
  // Guardamos com o país porque é como o WhatsApp identifica; eles querem sem.
  // Mandar `5511999998888` cru vira um DDD 55 que não existe.
  assertEquals(telefoneBR("5511999998888"), "(11) 99999-8888");
  assertEquals(telefoneBR("551133334444"), "(11) 3333-4444");
  assertEquals(telefoneBR("(11) 99999-8888"), "(11) 99999-8888");
  assertEquals(telefoneBR("11999998888"), "(11) 99999-8888");
});

Deno.test("o documento vai só com números", async () => {
  const { buscar, gravado } = fetchDeMentira(CRIADA);

  await criarPixAmploPay(
    { referencia: "cob:a", valor: 10, pagador: PAGADOR },
    CREDENCIAIS,
    buscar,
  );

  assertEquals(gravado.corpo.client.document, "12345678900");
  assertEquals(gravado.corpo.client.phone, "(11) 99999-8888");
});

Deno.test("sem CPF, o campo não vai — nem vazio", async () => {
  const { buscar, gravado } = fetchDeMentira(CRIADA);

  await criarPixAmploPay({
    referencia: "cob:a",
    valor: 10,
    pagador: { ...PAGADOR, documento: undefined },
  }, CREDENCIAIS, buscar);

  /* É o caminho normal: numa conversa de WhatsApp há telefone e nome, e não
   * CPF. Mandar `document: ""` seria pior que omitir — validação de gateway
   * recusa string vazia e o erro nunca diz que foi por isso. */
  assertEquals("document" in gravado.corpo.client, false);
  assertEquals(gravado.corpo.client.name, "João da Silva");
});

Deno.test("documento em branco conta como ausente", async () => {
  const { buscar, gravado } = fetchDeMentira(CRIADA);

  await criarPixAmploPay(
    { referencia: "cob:a", valor: 10, pagador: { ...PAGADOR, documento: "   " } },
    CREDENCIAIS,
    buscar,
  );

  assertEquals("document" in gravado.corpo.client, false);
});

Deno.test("os itens viram produtos, e o vencimento e o aviso vão junto", async () => {
  const { buscar, gravado } = fetchDeMentira(CRIADA);

  await criarPixAmploPay({
    referencia: "cob:a",
    valor: 65,
    pagador: PAGADOR,
    itens: [{ nome: "Corte", valor: 45 }, { nome: "Barba", valor: 20 }],
    vence: "2026-08-26",
    avisarEm: "https://x/functions/v1/pagamentos/amplopay",
  }, CREDENCIAIS, buscar);

  assertEquals(gravado.corpo.products.length, 2);
  assertEquals(gravado.corpo.products[0].name, "Corte");
  assertEquals(gravado.corpo.products[0].price, 45);
  assertEquals(gravado.corpo.products[0].quantity, 1);
  assertEquals(gravado.corpo.dueDate, "2026-08-26");
  assertEquals(gravado.corpo.callbackUrl, "https://x/functions/v1/pagamentos/amplopay");
});

Deno.test("sem itens, não manda a lista vazia", async () => {
  const { buscar, gravado } = fetchDeMentira(CRIADA);

  await criarPixAmploPay(
    { referencia: "cob:a", valor: 10, pagador: PAGADOR },
    CREDENCIAIS,
    buscar,
  );

  // Campo opcional mandado vazio é um jeito conhecido de um gateway recusar
  // por validação, e o erro que ele devolve nunca diz isso.
  assertEquals("products" in gravado.corpo, false);
  assertEquals("dueDate" in gravado.corpo, false);
  assertEquals("callbackUrl" in gravado.corpo, false);
});

Deno.test("devolve o copia-e-cola, que é o que vai para o WhatsApp", async () => {
  const { buscar } = fetchDeMentira(CRIADA);

  const criada = await criarPixAmploPay(
    { referencia: "cob:a", valor: 10, pagador: PAGADOR },
    CREDENCIAIS,
    buscar,
  );

  assertEquals(criada.codigo, CRIADA.pix.code);
  assertEquals(criada.transacao, "clwuwmn4i0007emp9lgn66u1h");
  assertEquals(criada.imagem, "https://q/r");
  assertEquals(criada.checkout, "https://app.amplopay.com/order/cm92");
});

Deno.test("erro do gateway carrega o campo que causou", async () => {
  const { buscar } = fetchDeMentira({
    statusCode: 400,
    errorCode: "INVALID_INPUT",
    message: "O valor fornecido para o campo 'amount' é inválido.",
    details: { field: "amount", value: -20, issue: "deve ser positivo" },
  }, 400);

  const erro = await assertRejects(
    () =>
      criarPixAmploPay(
        { referencia: "cob:a", valor: -20, pagador: PAGADOR },
        CREDENCIAIS,
        buscar,
      ),
    ErroDoGateway,
  );

  // "Erro ao gerar Pix" manda a loja abrir chamado. O campo ela conserta.
  assertEquals(erro.codigo, "INVALID_INPUT");
  assertEquals(erro.campo, "amount");
});

Deno.test("aceito mas sem código não passa por criado", async () => {
  const { buscar } = fetchDeMentira({ transactionId: "tx", status: "OK", pix: {} });

  await assertRejects(
    () =>
      criarPixAmploPay(
        { referencia: "cob:a", valor: 10, pagador: PAGADOR },
        CREDENCIAIS,
        buscar,
      ),
    ErroDoGateway,
    "não devolveu o código Pix",
  );
});

Deno.test("status de criação não é status de pagamento", async () => {
  // `OK` quer dizer que o código nasceu, não que alguém pagou. Quem paga é o
  // postback. Confundir os dois faria toda cobrança nascer quitada.
  const { buscar } = fetchDeMentira({ ...CRIADA, status: "REJECTED", errorDescription: "recusada" });

  await assertRejects(
    () =>
      criarPixAmploPay(
        { referencia: "cob:a", valor: 10, pagador: PAGADOR },
        CREDENCIAIS,
        buscar,
      ),
    ErroDoGateway,
    "recusada",
  );
});

/* --- testar credenciais -------------------------------------------------- */

Deno.test("credencial com permissão de transações pode cobrar", async () => {
  const { buscar, gravado } = fetchDeMentira({
    name: "Credencial de produção",
    permissions: ["PRODUCER_TRANSACTIONS", "PRODUCER_DATA"],
    grantAllPermissions: false,
    expiresAt: null,
  }, 200);

  const c = await testarAmploPay(CREDENCIAIS, buscar);

  assertEquals(gravado.url, "https://app.amplopay.com/api/v1/gateway/producer/credentials");
  assertEquals(gravado.headers?.get("x-secret-key"), "sec");
  assertEquals(c.nome, "Credencial de produção");
  assertEquals(c.podeCobrar, true);
});

Deno.test("acesso total é lista vazia com a bandeira ligada", async () => {
  /* `grantAllPermissions` verdadeiro com `permissions: []` quer dizer acesso
   * TOTAL, e não nenhum. Ler só a lista reprovaria a credencial mais poderosa
   * que existe — e a loja trocaria uma chave que estava certa. */
  const { buscar } = fetchDeMentira({
    name: "Tudo",
    permissions: [],
    grantAllPermissions: true,
  }, 200);

  const c = await testarAmploPay(CREDENCIAIS, buscar);

  assertEquals(c.todas, true);
  assertEquals(c.podeCobrar, true);
});

Deno.test("credencial válida mas sem permissão de cobrar", async () => {
  /* O caso que um teste de "conectou?" aprovaria: a chave autentica, e falha
   * só na hora de criar a cobrança — com um cliente esperando do outro lado. */
  const { buscar } = fetchDeMentira({
    name: "Só leitura",
    permissions: ["PRODUCER_DATA"],
    grantAllPermissions: false,
  }, 200);

  const c = await testarAmploPay(CREDENCIAIS, buscar);

  assertEquals(c.podeCobrar, false);
});

Deno.test("chave errada vira erro com o código do gateway", async () => {
  const { buscar } = fetchDeMentira({
    statusCode: 401,
    errorCode: "GATEWAY_NO_CREDENTIALS",
    message: "Credenciais não fornecidas",
  }, 401);

  const erro = await assertRejects(
    () => testarAmploPay(CREDENCIAIS, buscar),
    ErroDoGateway,
  );

  assertEquals(erro.codigo, "GATEWAY_NO_CREDENTIALS");
});
