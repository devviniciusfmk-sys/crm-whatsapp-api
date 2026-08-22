import { assertEquals, assertRejects } from "jsr:@std/assert";
import {
  criarCliente,
  ErroDoPainel,
  lerCredenciais,
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

Deno.test("a procura é por USERNAME, nunca por id", async () => {
  const { buscar, gravado } = fetchDeMentira({ data: [{ username: "user1" }] });

  await procurarPorUsuario(PAINEL, "user1", buscar);

  const url = new URL(gravado.url!);

  assertEquals(url.searchParams.get("username"), "user1");

  /**
   * A regra que a especificação lista como erro real de produção: o id destes
   * painéis é um hashid ambíguo, e o mesmo valor aponta para clientes
   * diferentes em contextos diferentes. Confirmar por ele manda credenciais
   * para a pessoa errada — sem estourar nada.
   */
  assertEquals(url.searchParams.has("id"), false);
  assertEquals(url.searchParams.has("hashid"), false);
});

Deno.test("o token vai no cabeçalho, e NUNCA na URL", async () => {
  /**
   * Ele ia como `?token=…`. Token em query string entra no log de acesso do
   * servidor, no de todo proxy no caminho e no Referer da página seguinte — e
   * este é o token do painel INTEIRO: quem o pega administra a base toda.
   *
   * A documentação do Sigma é explícita, e é o que este teste guarda:
   * `Authorization: Bearer <token>` em todo endpoint. - 2026/08/22
   */
  const { buscar, gravado } = fetchDeMentira({ data: [{ username: "u" }] });

  await procurarPorUsuario(PAINEL, "u", buscar);

  assertEquals(
    gravado.headers?.get("authorization"),
    `Bearer ${PAINEL.token}`,
  );

  const url = new URL(gravado.url!);

  assertEquals(url.searchParams.has("token"), false);
  /* E o `userId` sai junto: um token de painel inteiro não precisa dizer de
   * quem é. */
  assertEquals(url.searchParams.has("userId"), false);
  assertEquals(gravado.url!.includes(PAINEL.token), false);
});

Deno.test("a procura entende as três formas de resposta", async () => {
  const lista = fetchDeMentira({ data: [{ username: "a" }] });
  assertEquals(
    (await procurarPorUsuario(PAINEL, "a", lista.buscar))?.username,
    "a",
  );

  const direto = fetchDeMentira({ username: "b" });
  assertEquals(
    (await procurarPorUsuario(PAINEL, "b", direto.buscar))?.username,
    "b",
  );

  const embrulhado = fetchDeMentira({ customer: { username: "c" } });
  assertEquals(
    (await procurarPorUsuario(PAINEL, "c", embrulhado.buscar))?.username,
    "c",
  );
});

Deno.test("cliente não achado é nulo, e não erro", async () => {
  /* Não achar é resposta, e não falha: é o que separa "criar" de "renovar". */
  const { buscar } = fetchDeMentira({ data: [] });

  assertEquals(await procurarPorUsuario(PAINEL, "ninguem", buscar), null);

  const quatroCemQuatro = fetchDeMentira("", 404);

  assertEquals(
    await procurarPorUsuario(PAINEL, "ninguem", quatroCemQuatro.buscar),
    null,
  );
});

Deno.test("criar manda o telefone TAMBÉM na nota", async () => {
  /* É pela nota que se acha o cliente depois: o usuário é gerado pelo painel e
   * ninguém o decorou. */
  const { buscar, gravado } = fetchDeMentira({ data: { username: "novo" } });

  await criarCliente(PAINEL, "pac-1", "5511999998888", "João", buscar);

  assertEquals(gravado.url, "https://painel.megabox.exemplo/webhook/customer/create");
  assertEquals(gravado.corpo?.note, "5511999998888");
  assertEquals(gravado.corpo?.whatsapp, "5511999998888");
  assertEquals(gravado.corpo?.packageId, "pac-1");
  assertEquals(gravado.corpo?.userId, "u-123");
});

Deno.test("renovar manda usuário e pacote, e o token vai no cabeçalho", async () => {
  const { buscar, gravado } = fetchDeMentira({ data: { username: "user1" } });

  await renovarCliente(PAINEL, "pac-anual", "user1", buscar);

  assertEquals(gravado.url, "https://painel.megabox.exemplo/webhook/customer/renew");
  assertEquals(gravado.corpo?.username, "user1");
  assertEquals(gravado.corpo?.packageId, "pac-anual");

  /* No cabeçalho, e não na URL: URL vai para log de servidor e de proxy. */
  assertEquals(gravado.headers?.get("authorization"), "Bearer segredo");
});

Deno.test("a barra do fim não vira barra dupla", async () => {
  /* `base_url` com e sem barra final é a diferença entre `/webhook` e
   * `//webhook` — e alguns servidores respondem 404 para o segundo. */
  const { buscar, gravado } = fetchDeMentira({ data: {} });

  await renovarCliente(
    { ...PAINEL, painel_url: "https://painel.exemplo///" },
    "p",
    "u",
    buscar,
  );

  assertEquals(gravado.url, "https://painel.exemplo/webhook/customer/renew");
});
