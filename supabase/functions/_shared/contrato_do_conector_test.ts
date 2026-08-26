import { assertEquals } from "jsr:@std/assert@1";
import {
  traduzirMensagem,
  traduzirStatus,
} from "./contrato_do_conector.ts";

/**
 * Os casos aqui saíram do fio, e não da minha cabeça: o payload de cada teste
 * é o que a ponte mandou de verdade em 2026/08/23, capturado por um proxy
 * posto entre ela e o Supabase depois de as sondas inventadas passarem todas.
 *
 *   cd supabase/functions && deno test --allow-all _shared/contrato_do_conector_test.ts
 */
const LOJA = "555381062741";

const base = {
  external_id: "wmw.x",
  content: { version: "1", type: "text", kind: "text", text: "bah" },
  timestamp: "2026-08-23T20:59:28-03:00",
};

Deno.test("conversa de duas pessoas: quem escreveu foi a LOJA", () => {
  /* O payload real que estourava: o dono mandou "bah" pelo celular. */
  const r = traduzirMensagem(
    { ...base, conversation_address: "555391424424", sender_address: LOJA },
    LOJA,
  );

  assertEquals(r.direction, "outgoing");
  /* O OUTRO, e não quem escreveu: com `sender_address` aqui, a mensagem cairia
   * numa conversa da loja consigo mesma. */
  assertEquals(r.contact_address, "555391424424");
  assertEquals(r.group_address, undefined);
});

Deno.test("conversa de duas pessoas: quem escreveu foi o cliente", () => {
  const r = traduzirMensagem(
    {
      ...base,
      conversation_address: "555391424424",
      sender_address: "555391424424",
    },
    LOJA,
  );

  assertEquals(r.direction, "incoming");
  assertEquals(r.contact_address, "555391424424");
});

Deno.test("sem remetente também é da casa", () => {
  /* O contrato diz "vazio quando a própria conta falou". A ponte carimba o
   * número desde `feat(sender)`, mas as duas formas circulam — e classificar
   * isto como ENTRADA faria o assistente responder ao próprio dono. */
  const r = traduzirMensagem(
    { ...base, conversation_address: "555391424424" },
    LOJA,
  );

  assertEquals(r.direction, "outgoing");
});

Deno.test("grupo: o chat é o grupo, o contato é o participante", () => {
  const r = traduzirMensagem(
    {
      ...base,
      conversation_address: "120363425911018291@g.us",
      sender_address: "555391424424",
    },
    LOJA,
  );

  assertEquals(r.direction, "incoming");
  assertEquals(r.group_address, "120363425911018291@g.us");
  assertEquals(r.contact_address, "555391424424");
});

Deno.test("grupo, falando a própria loja: participante nenhum", () => {
  const r = traduzirMensagem(
    { ...base, conversation_address: "120363425911018291@g.us", sender_address: LOJA },
    LOJA,
  );

  assertEquals(r.direction, "outgoing");
  assertEquals(r.group_address, "120363425911018291@g.us");
  assertEquals(r.contact_address, undefined);
});

Deno.test("o contrato ANTIGO passa intacto", () => {
  /* O Instagram nunca mandou `conversation_address`. Um tradutor que mexesse
   * nele quebraria um conector que estava funcionando — e o sintoma apareceria
   * num canal que ninguém tinha tocado. */
  const antiga = {
    ...base,
    direction: "incoming" as const,
    contact_address: "5511999999999",
  };

  assertEquals(traduzirMensagem(antiga, LOJA), antiga);
});

Deno.test("mensagem sem endereço nenhum passa como veio", () => {
  /* Não é papel do tradutor recusar: quem valida é o banco, e inventar um
   * endereço aqui esconderia o defeito em vez de deixá-lo estourar. */
  assertEquals(traduzirMensagem(base, LOJA), base);
});

Deno.test("o recibo segue o chat, e não tem direção", () => {
  assertEquals(
    traduzirStatus({
      external_id: "wmw.x",
      status: { read: "2026-08-23T20:59:29-03:00" },
      conversation_address: "555391424424",
    }),
    { external_id: "wmw.x", status: { read: "2026-08-23T20:59:29-03:00" }, contact_address: "555391424424" },
  );

  assertEquals(
    traduzirStatus({
      external_id: "wmw.y",
      status: { delivered: "x" },
      conversation_address: "120363425911018291@g.us",
    }).group_address,
    "120363425911018291@g.us",
  );
});

Deno.test("`conversation_address` some do que vai para o banco", () => {
  /* A coluna não existe nesta versão: deixá-la passar faz o PostgREST recusar
   * a linha inteira com PGRST204, que é o mesmo 500 opaco de novo. */
  const r = traduzirMensagem(
    { ...base, conversation_address: "555391424424", sender_address: LOJA },
    LOJA,
  ) as Record<string, unknown>;

  assertEquals("conversation_address" in r, false);
  assertEquals("sender_address" in r, false);
});

import { nomesDoLote } from "./contrato_do_conector.ts";

Deno.test("o nome de quem falou vira contato", () => {
  const { contatos } = nomesDoLote([
    {
      ...base,
      conversation_address: "555391424424",
      sender_address: "555391424424",
      sender_name: "Kadu Ferreira",
    },
  ]);

  assertEquals(contatos, [
    { address: "555391424424", extra: { name: "Kadu Ferreira" } },
  ]);
});

Deno.test("o assunto do grupo vira nome do grupo", () => {
  const { grupos } = nomesDoLote([
    {
      ...base,
      conversation_address: "120363425911018291@g.us",
      conversation_name: "Ofertas",
      sender_address: "555391424424",
      sender_name: "Kadu",
    },
  ]);

  assertEquals(grupos, [
    { address: "120363425911018291@g.us", name: "Ofertas" },
  ]);
});

Deno.test("mensagem que a LOJA mandou nomeia o cliente", () => {
  /* O caso que faria um cliente ficar como número para sempre: só recebeu
   * mensagens nossas, então `sender_name` nunca vem — mas o nome dele está
   * ali, em `conversation_name`. */
  const { contatos } = nomesDoLote([
    {
      ...base,
      conversation_address: "555391424424",
      conversation_name: "Kadu Ferreira",
      sender_address: LOJA,
    },
  ]);

  assertEquals(contatos, [
    { address: "555391424424", extra: { name: "Kadu Ferreira" } },
  ]);
});

Deno.test("nome vazio não vira nome", () => {
  /* O contrato diz "ambos vazios quando ninguém nunca os nomeou". Gravar ""
   * apagaria um nome bom que já estivesse na ficha. */
  const { contatos, grupos } = nomesDoLote([
    {
      ...base,
      conversation_address: "555391424424",
      conversation_name: "   ",
      sender_address: "555391424424",
      sender_name: "",
    },
  ]);

  assertEquals(contatos, []);
  assertEquals(grupos, []);
});

Deno.test("cem mensagens do mesmo grupo viram UMA linha", () => {
  /* Repetição é o normal, e é o que derrubava o lote inteiro no Postgres. */
  const muitas = Array.from({ length: 100 }, (_, i) => ({
    ...base,
    external_id: `wmw.${i}`,
    conversation_address: "120363425911018291@g.us",
    conversation_name: "Ofertas",
    sender_address: "555391424424",
    sender_name: "Kadu",
  }));

  const { contatos, grupos } = nomesDoLote(muitas);

  assertEquals(grupos.length, 1);
  assertEquals(contatos.length, 1);
});

import { remetenteDoId } from "./contrato_do_conector.ts";

/**
 * Os casos do histórico — os que custaram 867 mensagens classificadas ao
 * contrário antes de alguém contar os remetentes.
 */
Deno.test("sem sender_address, quem falou sai do external_id", () => {
  const r = traduzirMensagem(
    {
      ...base,
      external_id: "wmw.555381062741.120363428518414159.5511952507037.A53C6D",
      conversation_address: "120363428518414159@g.us",
    },
    LOJA,
  );

  assertEquals(r.direction, "incoming");
  assertEquals(r.contact_address, "5511952507037");
});

Deno.test("e quando o external_id diz que fui EU, continua saída", () => {
  const r = traduzirMensagem(
    {
      ...base,
      external_id: `wmw.${LOJA}.120363428518414159.${LOJA}.A53C6D`,
      conversation_address: "120363428518414159@g.us",
    },
    LOJA,
  );

  assertEquals(r.direction, "outgoing");
  assertEquals(r.contact_address, undefined);
});

Deno.test("o campo explícito manda mais que o id", () => {
  /* Se um dia os dois discordarem, vale o que o conector afirmou de propósito.
   * O id é a leitura de reserva, não a autoridade. */
  const r = traduzirMensagem(
    {
      ...base,
      external_id: "wmw.555381062741.120363428518414159.5511111111111.A53C6D",
      conversation_address: "120363428518414159@g.us",
      sender_address: "5522222222222",
    },
    LOJA,
  );

  assertEquals(r.contact_address, "5522222222222");
});

Deno.test("conversa de duas pessoas também aproveita o id", () => {
  /* Em DM o contato é o chat, então a direção é a única coisa em jogo — e ela
   * decide se a conversa aparece como "pendente" esperando resposta. */
  const r = traduzirMensagem(
    {
      ...base,
      external_id: "wmw.555381062741.555391424424.555391424424.AC475A",
      conversation_address: "555391424424",
    },
    LOJA,
  );

  assertEquals(r.direction, "incoming");
  assertEquals(r.contact_address, "555391424424");
});

Deno.test("id de outro formato não vira palpite", () => {
  /* `wamid.…` é da API oficial: cada posição significa outra coisa ali, e ler
   * o quarto pedaço dele seria inventar um remetente. */
  assertEquals(remetenteDoId("wamid.HBgNNTU..."), undefined);
  assertEquals(remetenteDoId("wmw.a.b.c"), undefined);
  assertEquals(remetenteDoId(""), undefined);
  assertEquals(remetenteDoId(undefined), undefined);
  /* Segmento vazio é ausência, e não um endereço chamado "". */
  assertEquals(remetenteDoId("wmw.a.b..e"), undefined);
});

Deno.test("ponto no id da MENSAGEM não esconde quem falou", () => {
  /* Este caso estava escrito ao contrário: eu afirmava que um id com seis
   * pedaços não valia. O `ids.go` da ponte usa `SplitN(ext, ".", 5)` e explica
   * — "the message ID may itself contain dots". Exigir exatamente cinco
   * recusaria justamente o id que carrega a resposta, e a mensagem voltaria a
   * ser "da casa". Um teste que consagra a regra errada é pior que teste
   * nenhum: ele defende o defeito. - 2026/08/24 */
  assertEquals(remetenteDoId("wmw.meu.chat.5511999.AB.CD.EF"), "5511999");
  assertEquals(remetenteDoId("wmw.a.b.c.d.e"), "c");
});

Deno.test("sem sender e sem id utilizável, continua sendo da casa", () => {
  /* O contrato diz "vazio quando a própria conta falou", e sem nada que
   * contradiga isso a leitura dele é a que vale. */
  const r = traduzirMensagem(
    { ...base, external_id: "outro-formato", conversation_address: "5553999" },
    LOJA,
  );

  assertEquals(r.direction, "outgoing");
});
