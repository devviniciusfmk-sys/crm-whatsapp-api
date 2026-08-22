import { assertEquals } from "jsr:@std/assert";
import { lerCredenciais } from "./painel.ts";

Deno.test("hora do painel é hora DA LOJA, e não UTC", () => {
  /* O painel disse 14:55:36. Em Brasília isso é 17:55:36 UTC — e foi
   * exatamente a diferença de três horas que ficou gravada errada na primeira
   * chamada de verdade. */
  const lido = lerCredenciais(
    { username: "u", expiresAt: "2026-08-22 14:55:36" },
    null,
    "America/Sao_Paulo",
  );

  assertEquals(lido.expira_em, "2026-08-22T17:55:36.000Z");
});

Deno.test("com fuso escrito, respeita o que veio", () => {
  const lido = lerCredenciais(
    { username: "u", expiresAt: "2026-08-22T14:55:36Z" },
    null,
    "America/Sao_Paulo",
  );

  assertEquals(lido.expira_em, "2026-08-22T14:55:36.000Z");
});

Deno.test("connections vira telas, e reply vem inteiro", () => {
  const lido = lerCredenciais({
    username: "u",
    connections: 3,
    reply: "🔰 BEM-VINDO",
  });

  assertEquals(lido.telas, 3);
  assertEquals(lido.reply, "🔰 BEM-VINDO");
});
