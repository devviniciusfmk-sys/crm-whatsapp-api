import { assertEquals } from "jsr:@std/assert@1";
import { ultimoDeCada } from "./ultimo_de_cada.ts";

/**
 * O que este teste guarda custou uma noite de pareamento: com a repetição
 * passando adiante, o Postgres recusa o lote inteiro e o histórico não entra.
 *
 *   cd supabase/functions && deno test --allow-all _shared/ultimo_de_cada_test.ts
 */
Deno.test("repetida some, e sobra a última", () => {
  const linhas = [
    { id: "a", nome: "antigo" },
    { id: "b", nome: "outro" },
    { id: "a", nome: "novo" },
  ];

  assertEquals(ultimoDeCada(linhas, (l) => l.id), [
    { id: "a", nome: "novo" },
    { id: "b", nome: "outro" },
  ]);
});

Deno.test("a ordem é a da PRIMEIRA aparição de cada chave", () => {
  /* O `Map` guarda o lugar de quando a chave surgiu e só troca o conteúdo.
   * Sem isso, uma mensagem repetida saltaria para o fim do lote e a ordem
   * cronológica do histórico se embaralharia. */
  const linhas = [{ id: "a" }, { id: "b" }, { id: "a" }, { id: "c" }];

  assertEquals(ultimoDeCada(linhas, (l) => l.id).map((l) => l.id), [
    "a",
    "b",
    "c",
  ]);
});

Deno.test("linha sem chave passa inteira, e não vira uma só", () => {
  /* Agrupar tudo que é nulo sob a mesma cesta apagaria linhas boas — e o
   * jeito óbvio de escrever isto (`porChave.set(k, ...)` com k indefinido)
   * faz exatamente isso. */
  const linhas = [
    { id: undefined, n: 1 },
    { id: undefined, n: 2 },
    { id: "", n: 3 },
  ];

  assertEquals(ultimoDeCada(linhas, (l) => l.id).length, 3);
});

Deno.test("lote sem repetição sai como entrou", () => {
  /* A trava não pode mexer no caso comum: se o lote já está limpo, o que sai
   * tem de ser idêntico ao que entrou, na mesma ordem. */
  const linhas = [{ id: "a" }, { id: "b" }, { id: "c" }];

  assertEquals(ultimoDeCada(linhas, (l) => l.id), linhas);
});

Deno.test("lote vazio não estoura", () => {
  assertEquals(ultimoDeCada([], (l: { id: string }) => l.id), []);
});
