import { assertEquals } from "jsr:@std/assert";
import { mesmoNumero, profissionalDoNumero } from "./staff.ts";

/**
 * O `if` que separa o barbeiro do estranho.
 *
 * É o único ponto do sistema onde um erro entrega a lista de clientes da loja
 * — nome e horário — a quem não devia. Por isso a decisão é código e não
 * instrução, e por isso este arquivo existe: uma expressão nova aqui é
 * conferida contra o caso certo e contra o caso perigoso de uma vez.
 */

Deno.test("o mesmo número escrito de dois jeitos é o mesmo número", () => {
  // O dono digita como fala; o WhatsApp entrega com o país na frente.
  assertEquals(mesmoNumero("11 99999-8888", "5511999998888"), true);
  assertEquals(mesmoNumero("(11) 99999-8888", "5511999998888"), true);
  assertEquals(mesmoNumero("+55 11 99999-8888", "5511999998888"), true);
  assertEquals(mesmoNumero("5511999998888", "5511999998888"), true);
});

Deno.test("números diferentes continuam diferentes", () => {
  assertEquals(mesmoNumero("11999998888", "11999998889"), false);
  assertEquals(mesmoNumero("5511999998888", "5521999998888"), false);
});

Deno.test("sufixo curto não casa com meio mundo", () => {
  // Sem o piso de dez dígitos, "8888" casaria com todo número terminado nisso
  // — e a agenda da loja sairia para quem tivesse sorte.
  assertEquals(mesmoNumero("8888", "5511999998888"), false);
  assertEquals(mesmoNumero("998888", "5511999998888"), false);
});

Deno.test("sem número cadastrado, ninguém é reconhecido", () => {
  assertEquals(mesmoNumero(undefined, "5511999998888"), false);
  assertEquals(mesmoNumero("", "5511999998888"), false);
  assertEquals(mesmoNumero("5511999998888", null), false);
  assertEquals(mesmoNumero(null, null), false);
});

const EQUIPE = [
  { id: "j", name: "Jorge", extra: { phone: "11 99999-8888" } },
  { id: "m", name: "Marcos", extra: { phone: "11 97777-6666" } },
  { id: "r", name: "Rafa", extra: {} },
];

Deno.test("acha a pessoa do número, e só ela", () => {
  assertEquals(profissionalDoNumero(EQUIPE, "5511999998888")?.name, "Jorge");
  assertEquals(profissionalDoNumero(EQUIPE, "5511977776666")?.name, "Marcos");
});

Deno.test("quem não cadastrou telefone não é reconhecido por nada", () => {
  // A Rafa existe na equipe e não tem número: nenhuma mensagem é dela.
  assertEquals(profissionalDoNumero(EQUIPE, "5511900000000"), null);
  assertEquals(profissionalDoNumero(EQUIPE, ""), null);
});

Deno.test("um cliente qualquer nunca é um barbeiro", () => {
  assertEquals(profissionalDoNumero(EQUIPE, "5521988887777"), null);
});
