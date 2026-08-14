import { assertEquals } from "jsr:@std/assert";
import { quandoFalar } from "./quando_falar.ts";

/**
 * O leitor de "me chama às 19".
 *
 * Duas metades, e a segunda é a que importa: o que ele NÃO pode ler. Um leitor
 * generoso demais enche a tela de sugestões sobre preço e telefone, o dono
 * aprende a ignorar o aviso, e no dia em que a sugestão é a certa ele ignora
 * também. Falso positivo aqui não custa uma mensagem errada — custa a atenção,
 * que é o que faz o recurso existir.
 *
 * A hora "agora" é sempre passada de fora: metade das regras depende dela, e um
 * teste que usa o relógio da máquina passa de manhã e falha à noite.
 */

const TARDE = { hora: 14, minuto: 0 };
const NOITE = { hora: 21, minuto: 0 };
const MANHA = { hora: 9, minuto: 0 };

Deno.test("pede contato com hora cheia", () => {
  const r = quandoFalar("agora não posso falar, me chama às 19h", TARDE);

  assertEquals(r?.hora, 19);
  assertEquals(r?.minuto, 0);
  assertEquals(r?.amanha, false);
});

Deno.test("hora com minuto não perde o minuto", () => {
  // A ordem dos padrões é o que garante isto: "19h30" tem de casar com o padrão
  // dos minutos antes do padrão da hora cheia. Invertidos, todo mundo receberia
  // a mensagem meia hora antes.
  assertEquals(quandoFalar("me chama 19h30", TARDE)?.minuto, 30);
  assertEquals(quandoFalar("me chama às 19:45", TARDE)?.minuto, 45);
  assertEquals(quandoFalar("me chama às 19:45", TARDE)?.hora, 19);
});

Deno.test("disse quando pode, sem pedir nada", () => {
  // A forma mais comum na vida real, e a que não tem verbo de pedido nenhum.
  const r = quandoFalar(
    "não posso falar agora, só quando chegar em casa às 19",
    TARDE,
  );

  assertEquals(r?.hora, 19);
  assertEquals(r?.amanha, false);
});

Deno.test("sete da noite é dezenove", () => {
  assertEquals(quandoFalar("me chama às 7 da noite", TARDE)?.hora, 19);
  assertEquals(quandoFalar("me liga 3 da tarde", MANHA)?.hora, 15);
  assertEquals(quandoFalar("me chama às 8 da manhã", NOITE)?.hora, 8);
});

Deno.test("hora ambígua vira a PRÓXIMA que chegar", () => {
  // "Me chama às 7" às duas da tarde é sete da noite; a mesma frase às nove da
  // noite é sete da manhã. É como uma pessoa lê.
  const deTarde = quandoFalar("me chama às 7", TARDE);

  assertEquals(deTarde?.hora, 19);
  assertEquals(deTarde?.amanha, false);

  const deNoite = quandoFalar("me chama às 7", NOITE);

  assertEquals(deNoite?.hora, 7);
  assertEquals(deNoite?.amanha, true);
});

Deno.test("hora que já passou hoje cai para amanhã", () => {
  const r = quandoFalar("me chama às 13h", NOITE);

  assertEquals(r?.hora, 13);
  assertEquals(r?.amanha, true);
});

Deno.test("o cumprimento não é período do dia", () => {
  /**
   * "Boa noite" às nove da noite, com "me chama às 7", quer dizer sete da
   * MANHÃ. Casar o "noite" do cumprimento jogaria para as 19h — uma hora que já
   * passou — e a sugestão sairia com doze horas de erro.
   */
  const r = quandoFalar("boa noite! me chama às 7", NOITE);

  assertEquals(r?.hora, 7);
  assertEquals(r?.amanha, true);
});

Deno.test("amanhã é amanhã, e de uma às seis é da tarde", () => {
  assertEquals(quandoFalar("me chama amanhã às 10", TARDE)?.amanha, true);
  assertEquals(quandoFalar("me chama amanhã às 10", TARDE)?.hora, 10);
  assertEquals(quandoFalar("me chama amanhã às 3", TARDE)?.hora, 15);
});

Deno.test("depois de amanhã não é amanhã", () => {
  // Contém "amanha" dentro. Sem a regra do outro dia, sairia com dois dias de
  // erro — e o chip mostra a HORA, então o dono confirmaria sem reparar.
  assertEquals(quandoFalar("me chama depois de amanhã às 10", TARDE), null);
});

Deno.test("daqui a duas horas é relativo, e não duas da tarde", () => {
  const r = quandoFalar("me chama daqui a 2 horas", TARDE);

  assertEquals(r?.hora, 16);
  assertEquals(r?.amanha, false);

  assertEquals(quandoFalar("me liga daqui a uma hora", NOITE)?.hora, 22);
  assertEquals(quandoFalar("me chama daqui a 30 minutos", TARDE)?.minuto, 30);
});

Deno.test("daqui a duas horas pode virar o dia", () => {
  const r = quandoFalar("me chama daqui a 4 horas", { hora: 22, minuto: 0 });

  assertEquals(r?.hora, 2);
  assertEquals(r?.amanha, true);
});

Deno.test("meio-dia e meia-noite", () => {
  assertEquals(quandoFalar("me chama meio-dia", MANHA)?.hora, 12);
  assertEquals(quandoFalar("me chama meio dia", MANHA)?.amanha, false);
  assertEquals(quandoFalar("me chama meio-dia", NOITE)?.amanha, true);
  assertEquals(quandoFalar("me chama meia-noite", NOITE)?.hora, 0);
});

// --- o que ele NÃO pode ler -------------------------------------------------

Deno.test("preço não é hora", () => {
  assertEquals(quandoFalar("quanto custa? 45 reais?", TARDE), null);
  assertEquals(quandoFalar("me chama, quanto é? 45 reais", TARDE), null);
});

Deno.test("telefone não é hora", () => {
  assertEquals(quandoFalar("me chama no 11 98765 4321", TARDE), null);
});

Deno.test("conversa sem hora nenhuma", () => {
  assertEquals(quandoFalar("me chama mais tarde", TARDE), null);
  assertEquals(quandoFalar("bom dia, tudo bem?", TARDE), null);
  assertEquals(quandoFalar("obrigado!", TARDE), null);
});

Deno.test("marcar corte é a agenda, não o retorno", () => {
  // Quem quer horário usa a agenda. Sugerir um retorno aqui seria oferecer a
  // ferramenta errada para um pedido claro.
  assertEquals(quandoFalar("queria marcar às 19h", TARDE), null);
  assertEquals(quandoFalar("tem vaga às 15h?", MANHA), null);
});

Deno.test("mas pedir contato vence a palavra marcar", () => {
  // "Me chama" é pedido direto, e a menção à agenda é só o assunto da conversa.
  const r = quandoFalar("me chama às 19 que a gente marca", TARDE);

  assertEquals(r?.hora, 19);
});

Deno.test("dia da semana sai daqui sem sugestão", () => {
  // Passa da janela de 24 horas: precisaria de modelo aprovado, com custo e
  // categoria. Isso é o modal inteiro, e não cabe num toque.
  assertEquals(quandoFalar("me chama segunda às 10h", TARDE), null);
  assertEquals(quandoFalar("me chama semana que vem às 10h", TARDE), null);
  assertEquals(quandoFalar("me chama daqui a 3 dias às 10h", TARDE), null);
});

Deno.test("hora impossível não vira sugestão", () => {
  assertEquals(quandoFalar("me chama às 99h", TARDE), null);
});
