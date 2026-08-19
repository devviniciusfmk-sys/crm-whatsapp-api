import { assertEquals } from "jsr:@std/assert";
import {
  normalizar,
  passosComHora,
  sequenciaPara,
} from "./sequencia_por_palavra.ts";

const PRECOS = {
  name: "Preços",
  gatilhos: ["quanto custa", "preço"],
  steps: [
    { kind: "text" as const, name: "Tabela" },
    { kind: "media" as const, uri: "internal://media/foto", esperar: 60 },
  ],
};

const CATALOGO = {
  frases: [{ name: "Tabela", text: "Corte 45, barba 30." }],
  midias: [{
    uri: "internal://media/foto",
    name: "Tabela",
    mime_type: "image/png",
    size: 10,
    // `as const` para o tipo ser "image" e não string: o catálogo pede um
    // dos MediaTypes. - 2026/08/19
    kind: "image" as const,
  }],
};

Deno.test("acha pela palavra no meio da frase", () => {
  assertEquals(
    sequenciaPara("oi, quanto custa o corte?", [PRECOS])?.name,
    "Preços",
  );
});

Deno.test("ignora acento e maiúscula", () => {
  assertEquals(sequenciaPara("QUAL O PREÇO?", [PRECOS])?.name, "Preços");
  assertEquals(sequenciaPara("qual o preco?", [PRECOS])?.name, "Preços");
});

Deno.test("não dispara sem a palavra", () => {
  assertEquals(sequenciaPara("bom dia, tudo bem?", [PRECOS]), null);
});

Deno.test("mensagem vazia não dispara", () => {
  assertEquals(sequenciaPara("   ", [PRECOS]), null);
});

Deno.test("gatilho vazio não vira curinga", () => {
  const solto = { ...PRECOS, gatilhos: ["", "  "] };

  assertEquals(sequenciaPara("qualquer coisa", [solto]), null);
});

Deno.test("sem gatilho nenhum, não dispara", () => {
  const semGatilho = { name: "Solta", steps: PRECOS.steps };

  assertEquals(sequenciaPara("quanto custa", [semGatilho]), null);
});

Deno.test("a pausa vira hora futura, acumulada", () => {
  const agora = new Date("2026-08-18T12:00:00Z");
  const passos = passosComHora(PRECOS, CATALOGO, agora);

  assertEquals(passos.length, 2);
  // Sem carimbo: quem não espera nada é carimbado pelo banco na inserção.
  assertEquals(passos[0].quando, null);
  assertEquals(passos[1].quando?.toISOString(), "2026-08-18T12:01:00.000Z");
});

Deno.test("passo que aponta para algo apagado é pulado", () => {
  const passos = passosComHora(PRECOS, { frases: [], midias: [] });

  assertEquals(passos.length, 0);
});

Deno.test("normalizar tira acento e espaço sobrando", () => {
  assertEquals(normalizar("  Quanto   CUSTA?  "), "quanto custa?");
});

Deno.test("pausa curta vira espera de quem manda, e não hora futura", () => {
  const agora = new Date("2026-08-18T12:00:00Z");

  const curta = {
    ...PRECOS,
    steps: [
      { kind: "text" as const, name: "Tabela" },
      { kind: "text" as const, name: "Tabela", esperar: 30 },
    ],
  };

  const passos = passosComHora(curta, CATALOGO, agora);

  assertEquals(passos[1].dormir, 30);
  // Sem carimbo: quem espera é quem manda, e a hora certa é a da inserção.
  assertEquals(passos[1].quando, null);
});

Deno.test("pausa longa vira hora futura, e ninguém dorme", () => {
  const agora = new Date("2026-08-18T12:00:00Z");
  const passos = passosComHora(PRECOS, CATALOGO, agora);

  assertEquals(passos[1].dormir, 0);
  assertEquals(passos[1].quando?.toISOString(), "2026-08-18T12:01:00.000Z");
});
