/**
 * # A conversa com o painel de fora
 *
 * Todo painel de IPTV que este produto conhece fala o mesmo dialeto — é o
 * mesmo software, revendido com marcas diferentes. Quatro chamadas:
 *
 *   criarTeste     o robô do painel cria um usuário de teste e devolve
 *   procurar       acha um cliente pelo usuário
 *   criar          cria um cliente pago
 *   renovar        soma prazo a um cliente que já existe
 *
 * ## Nada aqui grava no nosso banco
 *
 * De propósito. Este arquivo é só o telefone; quem decide o que fazer com a
 * resposta é quem chama. Misturar as duas coisas é o que torna impossível
 * testar a chamada sem um painel de verdade.
 *
 * ## O `fetch` entra por parâmetro
 *
 * Mesma decisão de `pagamentos/criar.ts`, pelo mesmo motivo: é a única forma
 * de afirmar alguma coisa sobre a REQUISIÇÃO, e é na requisição que moram os
 * erros caros. Nenhum teste aqui prova que o painel aceita o que mandamos —
 * isso só o primeiro teste de verdade prova. O que eles provam é que mandamos
 * o que a documentação descreve.
 * - 2026/08/22
 */

export class ErroDoPainel extends Error {
  constructor(
    readonly status: number,
    mensagem: string,
  ) {
    super(mensagem);
    this.name = "ErroDoPainel";
  }
}

export type Painel = {
  /** A raiz do painel, sem barra no fim. */
  base_url: string;
  /** O painel administrativo, quando é outro endereço. */
  painel_url?: string | null;
  /** O identificador do revendedor lá dentro. */
  painel_user_id?: string | null;
  /** Do cofre. Nunca de uma coluna. */
  token: string;
};

export type Credenciais = {
  username: string;
  password: string;
  codigo?: string;
  dns?: string;
  m3u_url?: string;
  lista_url?: string;
  plano?: string;
  /** O link de pagamento que alguns painéis devolvem junto. */
  pagar_url?: string;
  /**
   * Quando o painel diz que expira, em ISO.
   *
   * Medido contra um servidor real em 2026/08/22: ele devolve `expiresAt`,
   * e essa é a data que vale. A nossa conta — começou agora, dura duas
   * horas — dá quase sempre no mesmo minuto e às vezes não: o relógio dele
   * é outro, e um teste de duas horas criado às 12:46:51 expira às
   * 14:46:50, um segundo antes.
   *
   * A diferença aparece na única hora que importa: o cliente tentando
   * entrar no minuto do fim, com a nossa mensagem dizendo que ainda dá
   * tempo. Quem conta os dias é o painel; nós repetimos o que ele contou.
   */
  expira_em?: string;
  /**
   * Quantas telas ao mesmo tempo, quando o painel diz.
   *
   * Vem como `connections`. Vale mais que o número da nossa configuração:
   * quem entrega o acesso é ele.
   */
  telas?: number;
  /**
   * A mensagem que o próprio painel já montou.
   *
   * Estes robôs devolvem um `reply` pronto — com DNS, usuário, senha, lista
   * M3U e os códigos de TODOS os aplicativos parceiros — porque é o que eles
   * mandam no site do revendedor.
   *
   * É a razão de o link sozinho já resolver: sem cadastrar app nenhum, sem
   * escrever texto nenhum, a loja cola o link e a mensagem sai completa. O
   * catálogo de apps e os textos próprios continuam existindo para quem quer
   * mandar do jeito dele — e passam na frente quando existem.
   */
  reply?: string;
};

const semBarra = (url: string) => url.replace(/\/+$/, "");

/**
 * Lê as credenciais de uma resposta, aceitando os nomes que os painéis usam.
 *
 * A mesma informação chega com três nomes diferentes dependendo da versão do
 * painel — `url_m3u`, `m3u_url`, `m3u`. Escolher um e torcer é como se perde
 * um campo inteiro numa atualização do provedor, sem erro nenhum: o campo
 * simplesmente vem vazio e a mensagem sai sem ele.
 */
export function lerCredenciais(
  corpo: Record<string, unknown>,
  codigoConfigurado?: string | null,
  /**
   * O fuso em que o painel escreve as horas dele.
   *
   * É o da loja: estes painéis são brasileiros e mandam hora local sem
   * dizer o fuso. Ver `comoIso`.
   */
  fuso = "America/Sao_Paulo",
): Credenciais {
  const texto = (...nomes: string[]): string | undefined => {
    for (const nome of nomes) {
      const valor = corpo[nome];

      if (typeof valor === "string" && valor.trim()) return valor.trim();
    }

    return undefined;
  };

  /**
   * "2026-08-22 14:46:50" → ISO, sabendo que aquilo é hora DA LOJA.
   *
   * ## Três horas de diferença, e nenhum erro na tela
   *
   * O painel manda a hora local dele e não diz o fuso. `new Date("…T14:46")`
   * usa o fuso de quem interpreta — e quem interpreta é uma função de borda,
   * que roda em UTC. Um teste que vence às 14:46 em Brasília era gravado
   * como 14:46 UTC: três horas mais cedo.
   *
   * Nada quebrava. A mensagem sai com o texto do próprio painel, então o
   * cliente lia a hora certa; só o nosso banco ficava adiantado — e com ele
   * o guarda de reuso, que pararia de reusar um teste ainda vivo, e a
   * agenda, que mostraria o vencimento na hora errada.
   *
   * Achado na primeira chamada a um servidor de verdade, comparando o que
   * ficou gravado com o que a mensagem dizia. - 2026/08/22
   */
  const comoIso = (valor?: string) => {
    if (!valor) return undefined;

    /* Já veio com fuso — `Z` ou `+03:00`? Então ele sabe o que está dizendo
     * e não há o que adivinhar. */
    if (/(Z|[+-]\d{2}:?\d{2})$/.test(valor.trim())) {
      const pronta = new Date(valor.trim());

      return Number.isNaN(pronta.getTime()) ? undefined : pronta.toISOString();
    }

    const comoSeUtc = new Date(`${valor.trim().replace(" ", "T")}Z`);

    if (Number.isNaN(comoSeUtc.getTime())) return undefined;

    /* Quanto aquele instante está deslocado no fuso da loja. Calculado para
     * a data em questão, e não fixo: um `-03:00` escrito à mão erraria em
     * qualquer país com horário de verão. */
    const noFuso = new Date(
      comoSeUtc.toLocaleString("en-US", { timeZone: fuso }),
    );
    const emUtc = new Date(
      comoSeUtc.toLocaleString("en-US", { timeZone: "UTC" }),
    );

    return new Date(
      comoSeUtc.getTime() + (emUtc.getTime() - noFuso.getTime()),
    ).toISOString();
  };

  const telas = Number(corpo.connections ?? corpo.max_connections);

  return {
    username: texto("username", "user", "usuario") ?? "",
    password: texto("password", "pass", "senha") ?? "",
    expira_em: comoIso(texto("expiresAt", "expires_at", "expira_em")),
    telas: Number.isFinite(telas) && telas > 0 ? telas : undefined,
    reply: texto("reply", "mensagem", "message"),
    /* O código vem da NOSSA configuração, e não do painel: ele é do par
     * app+servidor, e o painel não sabe em qual app o cliente vai assistir. */
    codigo: codigoConfigurado?.trim() || undefined,
    dns: texto("dns", "url_portal", "portal_url", "portal"),
    m3u_url: texto("url_m3u", "m3u_url", "m3u"),
    lista_url: texto("url_lista", "lista_url", "lista"),
    plano: texto("nome_pacote", "package_name", "package"),
    pagar_url: texto("url_pagamento", "pay_url", "payUrl"),
  };
}

/**
 * Pede um teste ao robô do painel.
 *
 * ## Por que este endereço e não o de integração
 *
 * A especificação é explícita: `/integration/v1/customers` teve bugs
 * históricos e é instável. O robô — o mesmo que responde no site do revendedor
 * — é o caminho que funciona.
 *
 * ## Os cabeçalhos de navegador não são frescura
 *
 * Vários desses painéis recusam requisição sem `Origin` e `Referer` do próprio
 * domínio. Sem eles a resposta é 403, e o 403 lê como token errado — mandando
 * quem for depurar procurar no lugar errado.
 */
export async function pedirTeste(
  painel: Painel,
  urlDoRobo: string,
  buscar: typeof fetch = fetch,
  /** O fuso da loja, para ler as horas que o painel manda. */
  fuso = "America/Sao_Paulo",
): Promise<Credenciais & { bruto: Record<string, unknown> }> {
  let origem = semBarra(painel.base_url);

  try {
    const u = new URL(urlDoRobo);

    origem = `${u.protocol}//${u.host}`;
  } catch {
    /* URL relativa ou torta: fica a do servidor, que é o melhor palpite. */
  }

  const resposta = await buscar(urlDoRobo, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      origin: origem,
      referer: `${origem}/`,
    },
    body: JSON.stringify({}),
    /* Vinte segundos. Painel que demora mais que isso está fora do ar, e
     * segurar a conversa esperando é pior que dizer que falhou. */
    signal: AbortSignal.timeout(20_000),
  });

  const texto = await resposta.text();

  if (!resposta.ok) {
    throw new ErroDoPainel(resposta.status, texto.slice(0, 300));
  }

  let corpo: Record<string, unknown>;

  try {
    corpo = JSON.parse(texto) as Record<string, unknown>;
  } catch {
    throw new ErroDoPainel(resposta.status, `resposta ilegível: ${texto.slice(0, 200)}`);
  }

  return { ...lerCredenciais(corpo, undefined, fuso), bruto: corpo };
}

/**
 * # A Sigma API — o painel administrativo de verdade
 *
 * Até 2026/08/22 estas chamadas iam para `/webhook/customer{,/create,/renew}`,
 * endereços que vieram do documento de especificação e que NÃO EXISTEM. A
 * documentação do painel do piloto chegou no mesmo dia e é outra coisa: a
 * Sigma API, em `/api/integration/v1`, com dezenove endpoints.
 *
 * Conferido contra o servidor de verdade, só com GET: `/servers` e `/packages`
 * responderam, e é de lá que saem os hashids abaixo.
 *
 * ## Hashids: o mesmo texto quer dizer coisas diferentes
 *
 * A especificação avisava, e agora há prova. Do painel do piloto:
 *
 *   ANKWPKDPRq   é um PACOTE (2H teste completo c/adulto)
 *   ANKWPKDPRq   é também o REVENDEDOR "rodnei"
 *   BV4D3rLaqZ   é um SERVIDOR, e também o revendedor "super-sharkstreaming"
 *   bOxLAQLZ7a   é um PACOTE, e também o revendedor "alexandreantenas"
 *
 * Não são coincidências: cada tipo tem a sua própria sequência, cifrada com o
 * mesmo alfabeto. Passar um hashid de pacote onde se espera um de revendedor
 * não dá erro — acerta OUTRA COISA. É criar o cliente na conta de terceiro, ou
 * renovar a assinatura de quem não pagou.
 *
 * Por isso: nunca reaproveitar um id entre tipos, nunca inferir um do outro, e
 * procurar cliente sempre por `username`, que é único e legível.
 *
 * ## O link do robô é `/api/chatbot/{revendedor}/{pacote}`
 *
 * O link do piloto — `…/api/chatbot/RYAWRk1jlx/ANKWPKDPRq` — tem os dois: o
 * primeiro é o revendedor `adm-shark`, o segundo é o pacote de teste. Os dois
 * saíram das listagens acima. É por isso que colar o link basta.
 * - 2026/08/22
 */

/** Onde a Sigma mora, a partir da raiz que a loja configurou. */
function sigma(painel: Painel): string {
  return `${semBarra(painel.painel_url || painel.base_url)}/api/integration/v1`;
}

/**
 * # Uma chamada à Sigma, e o único lugar que sabe como ela responde
 *
 * Cabeçalhos, envelope `{data}`, corpo de erro e o 429 moram aqui. Espalhados,
 * cada chamada nova esquece um — e o que se esquece primeiro é o 429, que só
 * aparece quando a loja cresce.
 */
async function chamarSigma(
  painel: Painel,
  metodo: "GET" | "POST" | "PUT" | "DELETE",
  caminho: string,
  corpo: Record<string, unknown> | undefined,
  buscar: typeof fetch,
): Promise<unknown> {
  const resposta = await buscar(`${sigma(painel)}${caminho}`, {
    method: metodo,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${painel.token}`,
      ...(corpo ? { "content-type": "application/json" } : {}),
    },
    body: corpo ? JSON.stringify(corpo) : undefined,
    signal: AbortSignal.timeout(20_000),
  });

  const texto = await resposta.text();

  if (!resposta.ok) {
    /* A Sigma manda o motivo em `message`, e ele é o que serve para quem for
     * ler o log. O corpo cru só quando não der para ler. */
    let motivo = texto.slice(0, 300);

    try {
      const erro = JSON.parse(texto) as { message?: string };

      if (erro.message) motivo = erro.message;
    } catch {
      /* Não era JSON: fica o corpo cru, que já é melhor que nada. */
    }

    throw new ErroDoPainel(resposta.status, motivo);
  }

  const lido = JSON.parse(texto) as Record<string, unknown>;

  return lido.data ?? lido;
}

/**
 * # Procura um cliente PELO USUÁRIO, e nunca pelo id
 *
 * O usuário é único dentro do painel e é o único identificador em que dá para
 * confiar — os hashids colidem entre tipos (ver o bloco no topo). Confirmar
 * por id devolveria o cliente errado, e o erro não aparece como erro: aparece
 * como credenciais mandadas para a pessoa errada.
 *
 * `GET /customers?username=` filtra por igualdade, mas a conferência exata é
 * refeita aqui: um filtro que um dia vire parcial não pode virar, sozinho, uma
 * renovação na conta do vizinho.
 */
export async function procurarPorUsuario(
  painel: Painel,
  username: string,
  buscar: typeof fetch = fetch,
): Promise<Record<string, unknown> | null> {
  const dados = await chamarSigma(
    painel,
    "GET",
    `/customers?username=${encodeURIComponent(username)}&per_page=20`,
    undefined,
    buscar,
  ).catch(() => null);

  const lista = Array.isArray(dados)
    ? (dados as Record<string, unknown>[])
    : dados && typeof dados === "object"
    ? [dados as Record<string, unknown>]
    : [];

  return lista.find((c) => c.username === username) ?? null;
}

/** Um plano do painel, como a Sigma o descreve. */
export type PacoteDoPainel = {
  id: string;
  name: string;
  duration: number;
  duration_in: "MINUTES" | "HOURS" | "DAYS" | "MONTHS" | "YEARS";
  connections: number;
  is_trial: "YES" | "NO";
  is_adult: boolean;
  plan_price: number;
  server_id: string;
};

/**
 * # O catálogo de planos, TODAS as páginas
 *
 * `per_page` é limitado a 20 em silêncio: pedir 500 devolve 20 e nenhum erro.
 * Uma integração que não paginasse concluiria que o painel tem vinte planos —
 * e o plano de venda que ficasse na página dois simplesmente não existiria
 * para a loja.
 *
 * O teto de páginas é para nunca virar laço infinito num painel que responda
 * `last_page` torto. Vinte páginas são quatrocentos planos.
 */
export async function listarPacotes(
  painel: Painel,
  buscar: typeof fetch = fetch,
): Promise<PacoteDoPainel[]> {
  const todos: PacoteDoPainel[] = [];

  for (let pagina = 1; pagina <= 20; pagina++) {
    const dados = await chamarSigma(
      painel,
      "GET",
      `/packages?page=${pagina}&per_page=20`,
      undefined,
      buscar,
    );

    const lista = (Array.isArray(dados) ? dados : []) as PacoteDoPainel[];

    todos.push(...lista);

    if (lista.length < 20) break;
  }

  return todos;
}

/**
 * # Cria um cliente pago
 *
 * `packageId` é o hashid do PACOTE — o mesmo que sai de `listarPacotes` e o
 * mesmo que está na segunda metade do link do robô. Não é o do servidor nem o
 * do revendedor, e trocá-los não dá erro: acerta outro registro.
 *
 * `userId` fica de fora de propósito. Ele diria de qual revendedor o cliente
 * passa a ser, e o padrão — o dono do token — é o certo para uma loja que
 * vende em nome próprio. Preenchê-lo com um valor achado por aí é exatamente o
 * acidente que a colisão de hashids torna possível.
 */
export async function criarCliente(
  painel: Painel,
  dados: {
    packageId: string;
    username: string;
    password?: string;
    name?: string;
    whatsapp?: string;
    connections?: number;
    /** A referência do nosso pedido. É por ela que se acha depois. */
    note?: string;
  },
  buscar: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  return await chamarSigma(
    painel,
    "POST",
    "/customers",
    { ...dados, status: "ACTIVE" },
    buscar,
  ) as Record<string, unknown>;
}

/**
 * # Soma prazo a um cliente que já existe
 *
 * Por `customerId` — o hashid que veio de `procurarPorUsuario` ou da criação —
 * e não por username, porque é assim que a Sigma monta o caminho.
 *
 * Sem `expiresAt`, a renovação segue a duração do pacote, que é o que se quer
 * em quase todo caso: mandar uma data calculada aqui é duplicar uma conta que
 * o painel já sabe fazer, e discordar dele por um dia é um cliente ligando.
 */
export async function renovarCliente(
  painel: Painel,
  customerId: string,
  packageId: string,
  expiresAt: string | undefined,
  buscar: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  return await chamarSigma(
    painel,
    "POST",
    `/customers/${encodeURIComponent(customerId)}/renew`,
    { packageId, ...(expiresAt ? { expiresAt } : {}) },
    buscar,
  ) as Record<string, unknown>;
}
