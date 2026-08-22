/**
 * # Ler a parede que o painel manda
 *
 * O robô devolve um `reply` de cento e trinta linhas: seis endereços de DNS,
 * quinze aplicativos com o código de cada um, EPG, links curtos, códigos de
 * STB, uma loja de aplicativos e três downloads. É o que ele manda na página do
 * revendedor, onde a pessoa está sentada procurando o dela.
 *
 * No WhatsApp isso não funciona. Quem pediu o teste quer usar UM aplicativo —
 * o que ele já tem instalado — e recebe uma parede onde precisa caçar duas
 * linhas. A queixa não é estética: o cliente que não acha o código dele não
 * instala, não testa, e não compra.
 *
 * Então este arquivo faz uma coisa só: separa a parede em partes, para que
 * quem manda escolha o que mandar.
 *
 * ## Por que ler o texto, e não pedir a lista ao painel
 *
 * Porque não há de onde pedir. Os códigos não vêm em campo nenhum da resposta
 * — só dentro do `reply`, escritos para gente ler. Ou se lê o texto, ou a loja
 * digita quinze códigos à mão e os mantém atualizados quando o painel trocar
 * um deles.
 *
 * ## O que fazer quando não dá para ler
 *
 * Devolver vazio, e quem chama manda a parede inteira. Uma leitura que erra e
 * inventa é pior que uma que desiste: o cliente com o código errado tenta,
 * falha, e conclui que o serviço não presta. - 2026/08/22
 */

export type AppDoPainel = {
  /** Como o painel escreve: "Super Play", "PLAY SIM / ASSIST+". */
  nome: string;
  codigo: string;
};

export type Lida = {
  dns?: string;
  /** O segundo DNS, que vários painéis mandam para o Smarters. */
  dns_alternativo?: string;
  m3u?: string;
  apps: AppDoPainel[];
};

/** Tira emoji, asterisco de negrito e espaço à toa. */
function limpo(linha: string): string {
  return linha
    /* Emoji e símbolos: a faixa é a dos blocos de pictogramas, mais as
     * variações de apresentação que vêm coladas neles. */
    .replace(
      /[\u{1F000}-\u{1FAFF}\u{2190}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{20E3}]/gu,
      "",
    )
    .replace(/\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** O valor depois de "Rótulo:", quando a linha tem esse formato. */
function depoisDoRotulo(linha: string, rotulo: RegExp): string | undefined {
  const limpa = limpo(linha);
  const casou = limpa.match(rotulo);

  if (!casou) return undefined;

  const valor = limpa.slice(casou.index! + casou[0].length).trim();

  return valor || undefined;
}

/**
 * Só o bloco dos aplicativos parceiros.
 *
 * O texto inteiro tem outras linhas de "Código:" — a do STB, a do webplayer, a
 * da loja de aplicativos — e cada uma delas viraria um "aplicativo" com um nome
 * que não é nome de aplicativo. Recortar o bloco é o que separa quinze apps de
 * vinte e três linhas parecidas.
 *
 * As faixas de `━` são a divisória que o próprio painel usa.
 */
function blocoDosApps(texto: string): string | undefined {
  const linhas = texto.split("\n");

  const comeco = linhas.findIndex((l) => /APPS?\s+PARCEIROS/i.test(l));

  if (comeco < 0) return undefined;

  const resto = linhas.slice(comeco + 1);
  const fim = resto.findIndex((l) => /━{3,}/.test(l));

  return (fim < 0 ? resto : resto.slice(0, fim)).join("\n");
}

export function lerResposta(texto?: string | null): Lida {
  if (!texto?.trim()) return { apps: [] };

  const linhas = texto.split("\n");

  let dns: string | undefined;
  let dnsAlternativo: string | undefined;
  let m3u: string | undefined;

  for (const [i, linha] of linhas.entries()) {
    const comoDns = depoisDoRotulo(linha, /^DNS\s*:/i);

    if (comoDns && !dns) dns = comoDns;

    const smarters = depoisDoRotulo(linha, /^DNS\s+SMARTERS\s*:/i);

    if (smarters) dnsAlternativo = smarters;

    /* A lista M3U vem com o rótulo numa linha e o endereço na seguinte — é
     * como o painel escreve, e ler só a linha do rótulo daria vazio. */
    if (!m3u && /Lista\s+M3U/i.test(limpo(linha))) {
      const seguinte = linhas[i + 1]?.trim();

      if (seguinte?.startsWith("http")) m3u = seguinte;
    }
  }

  const bloco = blocoDosApps(texto);
  const apps: AppDoPainel[] = [];

  if (bloco) {
    const doBloco = bloco.split("\n");

    for (const [i, linha] of doBloco.entries()) {
      const codigo = depoisDoRotulo(linha, /^C[ÓO]DIGO\s*:/i);

      if (!codigo) continue;

      /**
       * O nome é a última linha com texto ANTES do código.
       *
       * E não a linha imediatamente anterior: entre o nome e o código costuma
       * haver uma linha em branco, e às vezes duas. Voltar até achar texto é o
       * que aguenta as duas formas sem precisar saber qual delas o painel usou
       * hoje.
       */
      let nome: string | undefined;

      for (let j = i - 1; j >= 0; j--) {
        const acima = limpo(doBloco[j]);

        if (!acima) continue;

        /* Se o que está acima também é um código, não há nome: a linha do
         * nome ficou para trás demais e insistir inventaria um. */
        if (/^C[ÓO]DIGO\s*:/i.test(acima)) break;

        nome = acima;
        break;
      }

      if (nome) apps.push({ nome, codigo });
    }
  }

  return { dns, dns_alternativo: dnsAlternativo, m3u, apps };
}

/** Sem acento, sem maiúscula, sem pontuação: é assim que dois nomes se comparam. */
function comparavel(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Acha o aplicativo que o cliente pediu.
 *
 * Casa por pedaço, e não por igualdade: ele escreve "super play" e o painel
 * chama de "Super Play"; escreve "smarters" e o painel chama de
 * "PLAY SIM / ASSIST+ / MAGIC PLAYER". Exigir o nome exato é exigir que o
 * cliente saiba como o painel escreve — que ele não sabe e não deveria.
 */
export function acharApp(
  apps: AppDoPainel[],
  procurado?: string | null,
): AppDoPainel | undefined {
  const alvo = comparavel(procurado ?? "");

  if (!alvo) return undefined;

  return (
    apps.find((a) => comparavel(a.nome) === alvo) ??
    apps.find((a) => comparavel(a.nome).includes(alvo)) ??
    apps.find((a) => alvo.includes(comparavel(a.nome)))
  );
}

/**
 * # A mensagem curta, com o aplicativo que ele pediu
 *
 * Quatro coisas: quem ele é, onde entra, o código do app dele, e até quando
 * vale. Nada mais.
 *
 * Sem app escolhido, a lista de NOMES entra no lugar do código — e não os
 * códigos todos. É a pergunta "qual você usa?" feita com as opções na frente,
 * que é a única forma de o cliente responder sem ter de saber o que existe.
 */
export function mensagemCurta(entrada: {
  username: string;
  password: string;
  dns?: string;
  dns_alternativo?: string;
  app?: AppDoPainel;
  /** Para a pergunta, quando não se escolheu app. */
  nomes?: string[];
  expira?: string;
  loja?: string;
}): string {
  const linhas: (string | null)[] = [
    "🎁 *Seu teste está pronto!*",
    "",
    `👤 *Usuário:* ${entrada.username}`,
    `🔑 *Senha:* ${entrada.password}`,
  ];

  if (entrada.app) {
    linhas.push("");
    linhas.push(`📱 *${entrada.app.nome}*`);
    linhas.push(`🔢 *Código:* ${entrada.app.codigo}`);
  }

  if (entrada.dns) {
    linhas.push("");
    linhas.push(`🌐 *DNS:* ${entrada.dns}`);

    /* O segundo DNS só quando ele existe E o app não foi escolhido: com o app
     * na mão, dois endereços são uma dúvida a mais na hora de digitar. */
    if (!entrada.app && entrada.dns_alternativo) {
      linhas.push(`🌐 *DNS Smarters:* ${entrada.dns_alternativo}`);
    }
  }

  if (!entrada.app && entrada.nomes?.length) {
    linhas.push("");
    linhas.push("📲 *Em qual app você vai assistir?*");
    linhas.push(entrada.nomes.map((n) => `• ${n}`).join("\n"));
    linhas.push("_Responda o nome e eu mando o código._");
  }

  if (entrada.expira) {
    linhas.push("");
    linhas.push(`⏰ *Vale até:* ${entrada.expira}`);
  }

  if (entrada.loja) {
    linhas.push("");
    linhas.push(`_${entrada.loja}_`);
  }

  return linhas.filter((l) => l !== null).join("\n").trim();
}
