import { assertEquals } from "jsr:@std/assert";
import {
  emReais,
  mensagensDaCobranca,
  servicoPara,
} from "./cobranca_por_palavra.ts";

const CATALOGO = [
  { name: "Corte", minutes: 30, price: 45, gatilhos: ["corte", "cabelo"] },
  { name: "Barba", minutes: 20, price: 35, gatilhos: ["barba"] },
  // Sem preço: existe no catálogo, mas cobrar zero é pior que não cobrar.
  { name: "Consulta", minutes: 10, gatilhos: ["consulta"] },
  // Com preço e sem gatilho: o normal. Cobrar sozinho é escolha por serviço.
  { name: "Pezinho", minutes: 10, price: 20 },
];

const LOJA = {
  name: "Barbearia do Zé",
  extra: {
    pix: { key: "ze@barbearia.com" },
    business_address: { city: "Campinas" },
  },
};

Deno.test("casa a palavra no meio da frase", () => {
  assertEquals(servicoPara("quanto é o corte?", CATALOGO)?.name, "Corte");
});

Deno.test("não liga para acento nem maiúscula", () => {
  assertEquals(servicoPara("QUANTO CUSTA A BARBA", CATALOGO)?.name, "Barba");
});

Deno.test("um serviço pode ter várias palavras", () => {
  assertEquals(servicoPara("corto o cabelo hoje?", CATALOGO)?.name, "Corte");
});

Deno.test("serviço SEM preço nunca casa", () => {
  assertEquals(servicoPara("queria uma consulta", CATALOGO), null);
});

Deno.test("serviço sem gatilho nunca casa", () => {
  assertEquals(servicoPara("quero fazer o pezinho", CATALOGO), null);
});

Deno.test("mensagem que não fala de serviço nenhum não casa", () => {
  assertEquals(servicoPara("bom dia, tudo bem?", CATALOGO), null);
});

Deno.test("mensagem vazia não casa", () => {
  assertEquals(servicoPara("   ", CATALOGO), null);
});

Deno.test("gatilho vazio não casa com tudo", () => {
  const perigoso = [{ name: "X", minutes: 10, price: 10, gatilhos: ["", " "] }];

  assertEquals(servicoPara("qualquer coisa", perigoso), null);
});

Deno.test("valor sai em reais, com vírgula", () => {
  assertEquals(emReais(45), "R$ 45,00");
  assertEquals(emReais(7.5), "R$ 7,50");
});

Deno.test("a cobrança vai em DUAS mensagens, a chave sozinha", () => {
  const msgs = mensagensDaCobranca(CATALOGO[0], LOJA)!;

  assertEquals(msgs.length, 2);
  assertEquals(msgs[0].includes("R$ 45,00"), true);
  /* A segunda é SÓ a chave: quem paga toca "copiar" na bolha e o WhatsApp
   * copia a bolha inteira, então qualquer frase junto faz o banco não
   * reconhecer o que foi colado. Nada antes, nada depois, nem quebra de
   * linha. */
  assertEquals(msgs[1], "ze@barbearia.com");
});

Deno.test("o serviço e o valor ficam na primeira, em negrito", () => {
  const msgs = mensagensDaCobranca(CATALOGO[0], LOJA)!;

  // Asterisco é negrito no WhatsApp. Sem o nome do serviço, quem recebe a
  // cobrança horas depois não sabe do que ela é.
  assertEquals(msgs[0].startsWith("*Corte*"), true);
  assertEquals(msgs[0].includes("R$ 45,00"), true);
});

Deno.test("sem chave cadastrada, não manda nada", () => {
  const semChave = { name: "Barbearia", extra: { pix: {} } };

  assertEquals(mensagensDaCobranca(CATALOGO[0], semChave), null);
});

Deno.test("chave com espaço sobrando sai limpa", () => {
  // Um espaço colado na chave é invisível na tela de configuração e faz o
  // banco recusar. Aparar é a única defesa possível daqui.
  const comEspaco = {
    name: "Barbearia",
    extra: { pix: { key: "  ze@barbearia.com  " } },
  };

  assertEquals(mensagensDaCobranca(CATALOGO[0], comEspaco)![1], "ze@barbearia.com");
});

Deno.test("o primeiro do catálogo vence, e não o mais longo", () => {
  // Dois serviços com a mesma palavra é erro de quem configurou. Escolher o
  // mais específico esconderia o erro atrás de um comportamento imprevisível.
  const ambiguo = [
    { name: "Corte", minutes: 30, price: 45, gatilhos: ["corte"] },
    { name: "Corte + barba", minutes: 50, price: 70, gatilhos: ["corte"] },
  ];

  assertEquals(servicoPara("quero corte", ambiguo)?.name, "Corte");
});
