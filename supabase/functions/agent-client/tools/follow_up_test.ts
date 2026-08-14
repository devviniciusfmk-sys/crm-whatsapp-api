import { assertEquals } from "jsr:@std/assert";
import {
  preencherCorpo,
  quantasVariaveis,
  valoresDoRetorno,
} from "./follow_up.ts";

/**
 * O acerto de contas entre o catálogo da tela e o que está aprovado na Meta.
 *
 * As duas listas andam em ritmos diferentes: o corpo do `retorno_solicitado`
 * mudou aqui em 2026/08/14 — de uma variável para três, para deixar de ser
 * lido como promoção — e quem aprovou a versão antiga continua com ela na conta
 * até reenviar. Nas duas o envio tem de funcionar.
 *
 * O erro que isto existe para não deixar acontecer não aparece em teste de
 * conversa nenhum: parâmetro a mais é `132000` na hora do ENVIO, dias depois do
 * agendamento, sem ninguém por perto para ver.
 */

const DADOS = { nome: "Marina", data: "14/08/2026", hora: "19:00" };

Deno.test("conta pelo maior índice, e não pelas ocorrências", () => {
  assertEquals(quantasVariaveis("Oi {{1}}, dia {{2}} às {{3}}."), 3);
  assertEquals(quantasVariaveis("Oi {{1}}!"), 1);
  assertEquals(quantasVariaveis("Sem variável nenhuma."), 0);

  // Duas ocorrências, uma variável só. Contar as ocorrências mandaria dois
  // parâmetros para um modelo de um, e a Meta recusa.
  assertEquals(quantasVariaveis("Oi {{1}}, até logo {{1}}."), 1);
});

Deno.test("o modelo novo recebe os três", () => {
  const corpo =
    "Oi {{1}}, retornando conforme você pediu para {{2}} às {{3}}. Pode falar agora?";

  assertEquals(valoresDoRetorno(corpo, DADOS), [
    "Marina",
    "14/08/2026",
    "19:00",
  ]);
});

Deno.test("o modelo antigo, de uma variável, continua funcionando", () => {
  // É o que está aprovado na conta de quem não reenviou. Mandar três aqui
  // seria trocar uma falha visível hoje por uma invisível na semana que vem.
  const antigo = "Oi {{1}}! Você pediu para eu te procurar agora.";

  assertEquals(valoresDoRetorno(antigo, DADOS), ["Marina"]);
});

Deno.test("modelo sem variável nenhuma não recebe parâmetro", () => {
  assertEquals(valoresDoRetorno("Estamos te chamando de volta.", DADOS), []);
});

Deno.test("a prévia mostra o que o cliente vai ler", () => {
  const corpo = "Oi {{1}}, retornando conforme você pediu para {{2}} às {{3}}.";

  assertEquals(
    preencherCorpo(corpo, valoresDoRetorno(corpo, DADOS)),
    "Oi Marina, retornando conforme você pediu para 14/08/2026 às 19:00.",
  );
});

Deno.test("a prévia do modelo antigo não deixa {{1}} à mostra", () => {
  const antigo = "Oi {{1}}! Você pediu para eu te procurar agora.";

  assertEquals(
    preencherCorpo(antigo, valoresDoRetorno(antigo, DADOS)),
    "Oi Marina! Você pediu para eu te procurar agora.",
  );
});
