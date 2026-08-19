import { assertEquals } from "jsr:@std/assert";
import {
  emReais,
  mensagensDaCobranca,
  servicoPara,
} from "./cobranca_por_palavra.ts";
import { pareceCodigoPix } from "./pix.ts";

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

Deno.test("a cobrança vai em DUAS mensagens, o código sozinho", () => {
  const msgs = mensagensDaCobranca(CATALOGO[0], LOJA, "abc123")!;

  assertEquals(msgs.length, 2);
  assertEquals(msgs[0].includes("R$ 45,00"), true);
  /* A segunda é SÓ o código: quem paga toca "copiar" na bolha e o WhatsApp
   * copia a bolha inteira, então qualquer frase junto faz o banco recusar.
   *
   * "Sem espaço" seria a checagem óbvia e está ERRADA — o nome de quem recebe
   * mora dentro do código, e "Barbearia do Ze" tem espaços. A propriedade de
   * verdade é que a mensagem COMECE no payload e TERMINE no CRC, sem nada
   * antes nem depois. */
  assertEquals(msgs[1].startsWith("0002"), true);
  assertEquals(/^\d{4}.+6304[0-9A-F]{4}$/.test(msgs[1]), true);
  assertEquals(msgs[1].includes("\n"), false);
  assertEquals(msgs[1].includes("R$"), false);
});

Deno.test("o código leva o valor e o identificador", () => {
  const msgs = mensagensDaCobranca(CATALOGO[0], LOJA, "abc123")!;

  assertEquals(msgs[1].includes("540545.00"), true);
  assertEquals(msgs[1].includes("abc123"), true);
});

Deno.test("sem chave cadastrada, não manda nada", () => {
  const semChave = { name: "Barbearia", extra: { pix: {} } };

  assertEquals(mensagensDaCobranca(CATALOGO[0], semChave), null);
});

Deno.test("sem cidade no endereço, o código ainda se monta", () => {
  const semEndereco = {
    name: "Barbearia",
    extra: { pix: { key: "ze@barbearia.com" } },
  };

  const msgs = mensagensDaCobranca(CATALOGO[0], semEndereco)!;

  assertEquals(msgs[1].includes("BRASIL"), true);
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

/* --- a trava do código inventado ----------------------------------------- */

Deno.test("reconhece um código de Pix inteiro", () => {
  const msgs = mensagensDaCobranca(CATALOGO[0], LOJA, "abc123")!;

  assertEquals(pareceCodigoPix(msgs[1]), true);
});

Deno.test("reconhece um código PELA METADE", () => {
  // Foi o caso real: o modelo estourou o limite no meio do código. Metade de
  // um Pix inventado é tão perigosa quanto o inteiro — o cliente cola e o
  // banco recusa, ou pior, aceita outra coisa.
  assertEquals(
    pareceCodigoPix("00020126460014br.gov.bcb.pix0124planosau"),
    true,
  );
});

Deno.test("não confunde conversa normal com código", () => {
  for (
    const frase of [
      "Corte: R$ 45,00. Pode pagar por Pix quando quiser.",
      "Minha chave Pix é planosaurora@outlook.com",
      "Aceitamos pix, cartão e dinheiro",
      "",
    ]
  ) {
    assertEquals(pareceCodigoPix(frase), false, frase);
  }
});

Deno.test("titular e banco entram com ícone, em linhas separadas", () => {
  const comDono = {
    name: "Barbearia",
    extra: {
      pix: { key: "ze@barbearia.com", titular: "José da Silva", banco: "Stone" },
    },
  };

  const msgs = mensagensDaCobranca(CATALOGO[0], comDono)!;

  assertEquals(msgs[0].includes("👤 Titular: José da Silva"), true);
  assertEquals(msgs[0].includes("🏦 Banco: Stone"), true);
  // O código segue sozinho na segunda: a assinatura é da PRIMEIRA mensagem.
  assertEquals(msgs[1].startsWith("0002"), true);
});

Deno.test("sem titular cadastrado, nada de linha vazia", () => {
  const msgs = mensagensDaCobranca(CATALOGO[0], LOJA)!;

  assertEquals(msgs[0].includes("Titular"), false);
  assertEquals(msgs[0].includes("\n\n\n"), false);
});
