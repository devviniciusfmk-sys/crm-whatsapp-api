import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { acharApp, lerResposta, mensagemCurta } from "./resposta.ts";

/**
 * A leitura da parede, testada contra a parede DE VERDADE.
 *
 * O texto abaixo é o que um servidor real devolveu em 2026/08/22, recortado
 * mas não reescrito: os emoji, as linhas em branco entre nome e código, as
 * faixas de divisão e as outras seções que também têm "Código:" estão como
 * chegaram.
 *
 * É o único jeito de este teste valer alguma coisa. Um texto inventado por mim
 * casaria com o meu leitor por construção, e não diria nada sobre o painel.
 */
const PAREDE = `🔰 *BEM-VINDO(A)* 🔰

💠 *SEUS DADOS DE ACESSO*
🌐 *Acesso Principal*

🛑 *DNS:* http://shark1001.top
🟠 *DNS SMARTERS:* http://akdemia.click

👤 *Usuário:* 214911156
🔑 *Senha:* 599416596

🔗 *Lista M3U:*
http://shark1001.top/get.php?username=214911156&password=599416596&type=m3u_plus&output=mpegts

━━━━━━━━━━━━━━━━━━

🔶 *APPS PARCEIROS* 🔶

💥 *Super Play*
Código: 00330

🫥 *Box Player*
Código: 00330

➕ *Blessed Player*
CÓDIGO: axp10

💢 *Vizzion Player*
Código: 442052

💥 *LAZER PLAY / FUN PLAY*
Código: 1407

🛡️ *PLAY SIM / ASSIST+ / MAGIC PLAYER*
Código: 938124

━━━━━━━━━━━━━━━━━━

📦 *INFORMAÇÕES DO PLANO*

📦 *Plano:* 📺2H TESTE COMPLETO C/ADULTO
📅 *Vencimento:* 22/08/2026 15:27:28
📶 *Conexões:* 1

━━━━━━━━━━━━━━━━━━

🖥️ *DNS STB / SMARTUP*

✳️ Principal: 45.39.210.32
Código: 1010

━━━━━━━━━━━━━━━━━━

📱 *APP PLAY STORE*

NOME DO APP:
RP725

CÓDIGO:
22405686`;

Deno.test("acha os SEIS apps parceiros, e só eles", () => {
  const lida = lerResposta(PAREDE);

  assertEquals(
    lida.apps.map((a) => a.nome),
    [
      "Super Play",
      "Box Player",
      "Blessed Player",
      "Vizzion Player",
      "LAZER PLAY / FUN PLAY",
      "PLAY SIM / ASSIST+ / MAGIC PLAYER",
    ],
  );
});

Deno.test("o código do STB e o da loja NÃO viram aplicativos", () => {
  /* Os dois estão fora do bloco de parceiros e têm "Código:" igual. Sem o
   * recorte, "Principal: 45.39.210.32" viraria um app chamado assim — e o
   * cliente receberia um endereço IP como se fosse o nome do aplicativo. */
  const lida = lerResposta(PAREDE);

  assertEquals(lida.apps.some((a) => a.codigo === "1010"), false);
  assertEquals(lida.apps.some((a) => a.codigo === "22405686"), false);
});

Deno.test("os códigos vêm certos, inclusive o que não é número", () => {
  const lida = lerResposta(PAREDE);
  const porNome = Object.fromEntries(lida.apps.map((a) => [a.nome, a.codigo]));

  assertEquals(porNome["Super Play"], "00330");
  assertEquals(porNome["Vizzion Player"], "442052");
  /* Escrito "CÓDIGO:" em maiúsculas e com letra no valor. */
  assertEquals(porNome["Blessed Player"], "axp10");
});

Deno.test("lê os dois DNS e a lista M3U da linha seguinte", () => {
  const lida = lerResposta(PAREDE);

  assertEquals(lida.dns, "http://shark1001.top");
  assertEquals(lida.dns_alternativo, "http://akdemia.click");
  assertStringIncludes(lida.m3u ?? "", "get.php?username=214911156");
});

Deno.test("texto que não dá para ler devolve vazio, e não invenção", () => {
  /* Quem chama manda a parede inteira quando isto acontece. Uma leitura que
   * erra e inventa é pior que uma que desiste: o cliente com o código errado
   * tenta, falha, e conclui que o serviço não presta. */
  assertEquals(lerResposta("qualquer coisa").apps, []);
  assertEquals(lerResposta("").apps, []);
  assertEquals(lerResposta(null).apps, []);
});

Deno.test("o cliente escreve como quiser e o app é achado", () => {
  const { apps } = lerResposta(PAREDE);

  assertEquals(acharApp(apps, "super play")?.codigo, "00330");
  assertEquals(acharApp(apps, "SUPER PLAY")?.codigo, "00330");
  assertEquals(acharApp(apps, "vizzion")?.codigo, "442052");

  /* "smarters" não é o nome do app: o painel chama de "PLAY SIM / ASSIST+ /
   * MAGIC PLAYER". Exigir o nome exato é exigir que o cliente saiba como o
   * painel escreve. */
  assertEquals(acharApp(apps, "play sim")?.codigo, "938124");
});

Deno.test("app que não existe é undefined, e não o primeiro da lista", () => {
  const { apps } = lerResposta(PAREDE);

  assertEquals(acharApp(apps, "netflix"), undefined);
  assertEquals(acharApp(apps, ""), undefined);
  assertEquals(acharApp(apps, null), undefined);
});

Deno.test("com app escolhido, a mensagem tem QUATRO coisas", () => {
  const { apps, dns, dns_alternativo } = lerResposta(PAREDE);

  const curta = mensagemCurta({
    username: "214911156",
    password: "599416596",
    dns,
    dns_alternativo,
    app: acharApp(apps, "super play"),
    expira: "22/08/2026 às 15:27",
  });

  assertStringIncludes(curta, "214911156");
  assertStringIncludes(curta, "Super Play");
  assertStringIncludes(curta, "00330");
  assertStringIncludes(curta, "15:27");

  /* E NENHUM dos outros cinco: é a razão de a mensagem curta existir. */
  assertEquals(curta.includes("442052"), false);
  assertEquals(curta.includes("Blessed"), false);
  assertEquals(curta.includes("EPG"), false);

  /* Com o app na mão, dois endereços de DNS são uma dúvida a mais na hora de
   * digitar. */
  assertEquals(curta.includes("akdemia"), false);

  /* Quinze linhas contra cento e trinta. */
  assertEquals(curta.split("\n").length < 16, true);
});

Deno.test("sem app escolhido, pergunta com os NOMES na frente", () => {
  const { apps, dns } = lerResposta(PAREDE);

  const curta = mensagemCurta({
    username: "214911156",
    password: "599416596",
    dns,
    nomes: apps.map((a) => a.nome),
  });

  assertStringIncludes(curta, "Em qual app");
  assertStringIncludes(curta, "Super Play");
  assertStringIncludes(curta, "Vizzion Player");

  /* Os nomes, e não os códigos: a pergunta é qual, e um código antes da
   * resposta é a parede de volta em tamanho menor. */
  assertEquals(curta.includes("00330"), false);
  assertEquals(curta.includes("442052"), false);
});
