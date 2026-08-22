import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { renderizar, TEXTO_PADRAO } from "./texto.ts";

/**
 * O texto que leva credenciais é a última coisa entre o sistema e o cliente.
 *
 * Errar aqui não estoura nada: a mensagem sai, chega, e está errada. Um
 * `{codigo}` cru é a loja mostrando o molde; uma linha de "duração 2 horas"
 * embaixo de um plano anual é a loja parecendo que não sabe o que vendeu.
 * Nenhum dos dois aparece em log nenhum.
 */

Deno.test("os buracos viram os dados", () => {
  const saida = renderizar("Usuário: {usuario} · Senha: {senha}", {
    username: "user12345",
    password: "pass123",
  });

  assertEquals(saida, "Usuário: user12345 · Senha: pass123");
});

Deno.test("buraco sem dado fica VAZIO, e não com o nome do campo", () => {
  const saida = renderizar("Código: {codigo}!", {});

  assertEquals(saida, "Código: !");
});

Deno.test("o que não é campo conhecido fica como está", () => {
  /* Um texto com `{promoção}` dentro não é um buraco: é alguém escrevendo com
   * chaves. Apagar seria comer parte da mensagem do dono da loja. */
  const saida = renderizar("Fim de ano {promocao} chegou", {});

  assertEquals(saida, "Fim de ano {promocao} chegou");
});

Deno.test("no TESTE, o bloco de teste fica e o de pago some", () => {
  const molde = "{#teste}vale {duracao}h{/teste}{#pago}plano {plano}{/pago}";

  assertEquals(renderizar(molde, { duracao: 2, comprado: false }), "vale 2h");
});

Deno.test("no PAGO, o inverso — e nenhuma palavra sobre duração", () => {
  const molde = [
    "{#teste}⏰ Vale por {duracao} horas{/teste}",
    "{#pago}📺 Plano: {plano}{/pago}",
  ].join("\n");

  const saida = renderizar(molde, {
    duracao: 2,
    plano: "Anual",
    comprado: true,
  });

  assertEquals(saida, "📺 Plano: Anual");
});

Deno.test("o código de OUTRO app entra pelo nome dele", () => {
  /* O caso de quem manda um texto só listando onde assistir: o texto do XCIPTV
   * precisa citar o código do Vizzion. */
  const saida = renderizar("Vizzion: {vizzion_codigo} · PlaySim: {playsim_codigo}", {
    codigos: { vizzion: "951982", playsim: "938124" },
  });

  assertEquals(saida, "Vizzion: 951982 · PlaySim: 938124");
});

Deno.test("o código do app ATUAL não é comido pelo do outro", () => {
  /* `{codigo}` e `{vizzion_codigo}` convivem no mesmo texto. Se a substituição
   * dos campos fixos rodasse primeiro, `{vizzion_codigo}` nunca casaria — o
   * `_codigo` já teria virado outra coisa. */
  const saida = renderizar("Este: {codigo} · Outro: {vizzion_codigo}", {
    codigo: "111111",
    codigos: { vizzion: "222222" },
  });

  assertEquals(saida, "Este: 111111 · Outro: 222222");
});

Deno.test("bloco descartado não deixa buraco de linhas em branco", () => {
  const molde = [
    "Título",
    "",
    "{#teste}só no teste{/teste}",
    "",
    "Rodapé",
  ].join("\n");

  assertEquals(renderizar(molde, { comprado: true }), "Título\n\nRodapé");
});

Deno.test("o texto padrão fala de duração no teste e de plano no pago", () => {
  const teste = renderizar(TEXTO_PADRAO, {
    username: "u1",
    password: "p1",
    duracao: 2,
    expira: "25/12/2026 às 18:30",
    comprado: false,
  });

  assertStringIncludes(teste, "Vale por:* 2 horas");
  assertStringIncludes(teste, "25/12/2026");
  assertEquals(teste.includes("Plano"), false);

  const pago = renderizar(TEXTO_PADRAO, {
    username: "u1",
    password: "p1",
    duracao: 2,
    plano: "Anual",
    comprado: true,
  });

  assertStringIncludes(pago, "Plano:* Anual");

  /* A regra que mais custa se quebrar: quem pagou o ano não pode ler que o
   * acesso dele vale duas horas. */
  assertEquals(pago.includes("horas"), false);
  assertEquals(pago.includes("teste"), false);
});

Deno.test("o padrão não promete DNS nem código, que são de alguns apps", () => {
  /* Uma linha "DNS:" vazia é pior que a ausência dela: o cliente procura o
   * dado, não acha, e pergunta. */
  assertEquals(TEXTO_PADRAO.includes("{dns}"), false);
  assertEquals(TEXTO_PADRAO.includes("{codigo}"), false);
});
