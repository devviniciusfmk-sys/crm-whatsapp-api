import { assertEquals, assertRejects } from "jsr:@std/assert";
import {
  criarCliente,
  ErroDoPainel,
  lerCredenciais,
  listarPacotes,
  pedirTeste,
  procurarPorUsuario,
  renovarCliente,
} from "./painel.ts";

/**
 * A conversa com o painel, testada sem painel nenhum.
 *
 * O `fetch` é trocado por um que grava o que foi mandado. Nada aqui prova que o
 * painel aceita o que mandamos — isso só o primeiro teste de verdade prova. O
 * que estes provam é que mandamos o que a documentação descreve, e é isso que
 * está sob nosso controle.
 *
 * Duas coisas específicas estão aqui porque a própria especificação as lista
 * como erros que já aconteceram em produção: a busca por hashid, que devolve o
 * cliente errado, e os cabeçalhos que faltando viram um 403 parecido com token
 * errado.
 */

const PAINEL = {
  base_url: "https://megabox.exemplo/",
  painel_url: "https://painel.megabox.exemplo/",
  painel_user_id: "u-123",
  token: "segredo",
};

/** Um `fetch` que responde o combinado e guarda o que recebeu. */
function fetchDeMentira(resposta: unknown, status = 200) {
  const gravado: {
    url?: string;
    metodo?: string;
    headers?: Headers;
    corpo?: Record<string, unknown>;
  } = {};

  const buscar = ((url: string, init: RequestInit = {}) => {
    gravado.url = url;
    gravado.metodo = init.method ?? "GET";
    gravado.headers = new Headers(init.headers);

    if (typeof init.body === "string") {
      gravado.corpo = JSON.parse(init.body) as Record<string, unknown>;
    }

    return Promise.resolve(
      new Response(
        typeof resposta === "string" ? resposta : JSON.stringify(resposta),
        { status },
      ),
    );
  }) as unknown as typeof fetch;

  return { buscar, gravado };
}

Deno.test("o teste é pedido ao ROBÔ, com cabeçalhos de navegador", async () => {
  const { buscar, gravado } = fetchDeMentira({
    username: "user1",
    password: "pass1",
  });

  await pedirTeste(PAINEL, "https://megabox.exemplo/api/chatbot/mensal", buscar);

  assertEquals(gravado.metodo, "POST");

  /* Sem `origin`/`referer` do próprio domínio vários painéis devolvem 403 — e
   * um 403 lê como token errado, mandando quem depura para o lugar errado. */
  assertEquals(gravado.headers?.get("origin"), "https://megabox.exemplo");
  assertEquals(gravado.headers?.get("referer"), "https://megabox.exemplo/");
  assertEquals(
    gravado.headers?.get("user-agent")?.startsWith("Mozilla/"),
    true,
  );
});

Deno.test("a origem sai da URL do robô, e não da do servidor", async () => {
  /* O robô costuma viver num subdomínio próprio. Mandar a origem do servidor
   * principal é o mesmo que não mandar. */
  const { buscar, gravado } = fetchDeMentira({ username: "u", password: "p" });

  await pedirTeste(PAINEL, "https://bot.outro.exemplo/chat", buscar);

  assertEquals(gravado.headers?.get("origin"), "https://bot.outro.exemplo");
});

Deno.test("erro do painel vira ErroDoPainel com o status dentro", async () => {
  const { buscar } = fetchDeMentira("acesso negado", 403);

  const erro = await assertRejects(
    () => pedirTeste(PAINEL, "https://megabox.exemplo/api/chatbot/", buscar),
    ErroDoPainel,
  );

  assertEquals((erro as ErroDoPainel).status, 403);
});

Deno.test("resposta que não é JSON também vira erro, e não credencial vazia", async () => {
  /* Um painel fora do ar devolve HTML com 200. Sem isto, as credenciais sairiam
   * vazias e o cliente receberia "Usuário: · Senha:". */
  const { buscar } = fetchDeMentira("<html>manutenção</html>", 200);

  await assertRejects(
    () => pedirTeste(PAINEL, "https://megabox.exemplo/api/chatbot/", buscar),
    ErroDoPainel,
  );
});

Deno.test("os três nomes do mesmo campo são aceitos", () => {
  /* A mesma informação chega com nomes diferentes conforme a versão do painel.
   * Escolher um e torcer é como se perde um campo inteiro numa atualização do
   * provedor, sem erro nenhum. */
  assertEquals(lerCredenciais({ url_m3u: "a" }).m3u_url, "a");
  assertEquals(lerCredenciais({ m3u_url: "b" }).m3u_url, "b");
  assertEquals(lerCredenciais({ m3u: "c" }).m3u_url, "c");

  assertEquals(lerCredenciais({ usuario: "x" }).username, "x");
  assertEquals(lerCredenciais({ senha: "y" }).password, "y");
});

Deno.test("o código vem da NOSSA configuração, e não do painel", () => {
  /* Ele é do par app+servidor, e o painel não sabe em qual app o cliente vai
   * assistir. Um código vindo de lá seria o de outro aplicativo. */
  const lido = lerCredenciais({ username: "u", codigo: "do-painel" }, "951982");

  assertEquals(lido.codigo, "951982");
});

/**
 * # A Sigma API, testada contra o que a documentação descreve
 *
 * As chamadas antigas iam para `/webhook/customer{,/create,/renew}` — endereços
 * do documento de especificação, que não existem. Estes testes guardam os de
 * verdade, e sobretudo guardam as três armadilhas que a documentação e o painel
 * do piloto mostraram:
 *
 *   o hashid colide entre tipos, e trocar um não dá erro — acerta outra coisa;
 *   `per_page` é limitado a 20 EM SILÊNCIO, então quem não pagina vê 20 e acha
 *     que é tudo;
 *   o token é do painel inteiro, e não pode aparecer em URL nenhuma.
 * - 2026/08/22
 */

const BASE = "https://painel.megabox.exemplo/api/integration/v1";

Deno.test("a procura é por USERNAME, nunca por hashid", async () => {
  const { buscar, gravado } = fetchDeMentira({ data: [{ username: "user1" }] });

  await procurarPorUsuario(PAINEL, "user1", buscar);

  const url = new URL(gravado.url!);

  assertEquals(url.pathname, "/api/integration/v1/customers");
  assertEquals(url.searchParams.get("username"), "user1");

  /**
   * Provado no painel do piloto em 2026/08/22: `ANKWPKDPRq` é ao mesmo tempo um
   * PACOTE e o revendedor "rodnei"; `BV4D3rLaqZ` é um SERVIDOR e o revendedor
   * "super-sharkstreaming". Cada tipo tem a sua sequência, cifrada com o mesmo
   * alfabeto — passar um pelo outro acerta um registro real e errado.
   */
  assertEquals(url.searchParams.has("id"), false);
  assertEquals(url.searchParams.has("hashid"), false);
});

Deno.test("um homônimo parcial NÃO é o cliente procurado", async () => {
  /* O filtro do painel é por igualdade hoje. Se um dia virar parcial — a busca
   * ao lado, `/customers/search`, já é —, procurar "ana" devolveria "ana2" e a
   * renovação cairia na conta dela. A conferência exata é refeita aqui. */
  const { buscar } = fetchDeMentira({
    data: [{ username: "ana2" }, { username: "ana" }],
  });

  assertEquals((await procurarPorUsuario(PAINEL, "ana", buscar))?.username, "ana");

  const so = fetchDeMentira({ data: [{ username: "ana2" }] });

  assertEquals(await procurarPorUsuario(PAINEL, "ana", so.buscar), null);
});

Deno.test("o token vai no cabeçalho, e NUNCA na URL", async () => {
  /**
   * Ele ia como `?token=…`. Token em query string entra no log de acesso do
   * servidor, no de todo proxy no caminho e no Referer da página seguinte.
   *
   * E a documentação diz o que ele é: "panel-wide token — do NOT share". Foi
   * conferido: com ele dá para listar TODOS os revendedores do painel e os
   * saldos de cada um.
   */
  const { buscar, gravado } = fetchDeMentira({ data: [{ username: "u" }] });

  await procurarPorUsuario(PAINEL, "u", buscar);

  assertEquals(gravado.headers?.get("authorization"), `Bearer ${PAINEL.token}`);
  assertEquals(gravado.headers?.get("accept"), "application/json");
  assertEquals(gravado.url!.includes(PAINEL.token), false);
});

Deno.test("cliente não achado é nulo, e não erro", async () => {
  /* Não achar é resposta, e não falha: é o que separa "criar" de "renovar". */
  const vazio = fetchDeMentira({ data: [] });

  assertEquals(await procurarPorUsuario(PAINEL, "ninguem", vazio.buscar), null);

  const quatroCemQuatro = fetchDeMentira({ error: true, message: "x" }, 404);

  assertEquals(
    await procurarPorUsuario(PAINEL, "ninguem", quatroCemQuatro.buscar),
    null,
  );
});

Deno.test("criar cliente vai para POST /customers, com o pacote", async () => {
  const { buscar, gravado } = fetchDeMentira({ data: { id: "C1" } });

  await criarCliente(
    PAINEL,
    {
      packageId: "ANKWPKDPRq",
      username: "cliente01",
      whatsapp: "5511999998888",
      note: "PEDIDO-1234",
    },
    buscar,
  );

  assertEquals(gravado.url, `${BASE}/customers`);
  assertEquals(gravado.metodo, "POST");
  assertEquals(gravado.corpo?.packageId, "ANKWPKDPRq");
  assertEquals(gravado.corpo?.username, "cliente01");
  assertEquals(gravado.corpo?.status, "ACTIVE");
  assertEquals(gravado.headers?.get("content-type"), "application/json");

  /**
   * `userId` NÃO vai. Ele diria de qual revendedor o cliente passa a ser, e o
   * padrão — o dono do token — é o certo para quem vende em nome próprio.
   * Preenchido com um hashid achado por aí, cria o cliente na conta de outro.
   */
  assertEquals("userId" in (gravado.corpo ?? {}), false);
});

Deno.test("renovar vai para POST /customers/{id}/renew", async () => {
  const { buscar, gravado } = fetchDeMentira({ data: { id: "C1" } });

  await renovarCliente(PAINEL, "C1", "PkaL4dLgrz", undefined, buscar);

  assertEquals(gravado.url, `${BASE}/customers/C1/renew`);
  assertEquals(gravado.metodo, "POST");
  assertEquals(gravado.corpo?.packageId, "PkaL4dLgrz");

  /* Sem data: a renovação segue a duração do pacote. Mandar uma calculada aqui
   * é refazer uma conta que o painel já faz, e discordar dele por um dia é um
   * cliente ligando. */
  assertEquals("expiresAt" in (gravado.corpo ?? {}), false);
});

Deno.test("o catálogo percorre TODAS as páginas", async () => {
  /**
   * `per_page` é limitado a 20 em silêncio: pedir 500 devolve 20 e nenhum erro.
   * Sem paginar, o plano que ficasse na página dois não existiria para a loja —
   * e ninguém veria nada errado, porque vinte planos parecem uma lista inteira.
   */
  const paginas = [
    Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, name: "x" })),
    [{ id: "ultimo", name: "y" }],
  ];

  let quantas = 0;

  const buscar = ((url: string) => {
    const pagina = Number(new URL(url).searchParams.get("page"));

    quantas++;

    return Promise.resolve(
      new Response(JSON.stringify({ data: paginas[pagina - 1] ?? [] }), {
        status: 200,
      }),
    );
  }) as unknown as typeof fetch;

  const todos = await listarPacotes(PAINEL, buscar);

  assertEquals(todos.length, 21);
  assertEquals(todos[20].id, "ultimo");
  /* Parou na página curta: uma terceira chamada seria desperdício e um passo a
   * mais rumo ao 429. */
  assertEquals(quantas, 2);
});

Deno.test("erro do painel traz a MENSAGEM dele, e não o corpo cru", async () => {
  /* A Sigma responde `{error:true, message:"…"}`. É a mensagem que diz se
   * faltou permissão, se o pacote não existe ou se bateu no limite — e é ela
   * que precisa chegar ao log. */
  const { buscar } = fetchDeMentira(
    { error: true, message: "Package not found" },
    400,
  );

  const erro = await assertRejects(
    () => criarCliente(PAINEL, { packageId: "x", username: "u" }, buscar),
    ErroDoPainel,
  );

  assertEquals(erro.status, 400);
  assertEquals(erro.message, "Package not found");
});

Deno.test("o 429 chega como erro, com o tempo de espera dentro", async () => {
  const { buscar } = fetchDeMentira(
    { message: "Too many requests. Please try again in 47 seconds." },
    429,
  );

  const erro = await assertRejects(
    () => criarCliente(PAINEL, { packageId: "x", username: "u" }, buscar),
    ErroDoPainel,
  );

  assertEquals(erro.status, 429);
  assertEquals(erro.message.includes("47 seconds"), true);
});

Deno.test("a barra do fim não vira barra dupla", async () => {
  /* `base_url` com e sem barra final é a diferença entre `/api` e `//api`, e
   * alguns servidores respondem 404 para o segundo. */
  const { buscar, gravado } = fetchDeMentira({ data: {} });

  await renovarCliente(
    { ...PAINEL, painel_url: "https://painel.exemplo///" },
    "C1",
    "p",
    undefined,
    buscar,
  );

  assertEquals(
    gravado.url,
    "https://painel.exemplo/api/integration/v1/customers/C1/renew",
  );
});
