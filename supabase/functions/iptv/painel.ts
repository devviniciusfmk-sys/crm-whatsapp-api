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
 * # Procura um cliente PELO USUÁRIO, e nunca pelo id
 *
 * O id que estes painéis devolvem é um hashid ambíguo: o mesmo valor aponta
 * para clientes diferentes em contextos diferentes. Confirmar por ele devolve
 * o cliente errado — e o erro não aparece como erro. Aparece como credenciais
 * mandadas para a pessoa errada, ou uma renovação aplicada na conta de outro.
 *
 * O usuário é único dentro do painel. É o único identificador em que dá para
 * confiar, e é por isso que esta função só aceita ele. - 2026/08/22
 */
export async function procurarPorUsuario(
  painel: Painel,
  username: string,
  buscar: typeof fetch = fetch,
): Promise<Record<string, unknown> | null> {
  const base = semBarra(painel.painel_url || painel.base_url);

  const url =
    `${base}/webhook/customer` +
    `?username=${encodeURIComponent(username)}` +
    `&token=${encodeURIComponent(painel.token)}` +
    `&userId=${encodeURIComponent(painel.painel_user_id ?? "")}`;

  const resposta = await buscar(url, {
    method: "GET",
    signal: AbortSignal.timeout(20_000),
  });

  if (!resposta.ok) return null;

  const corpo = (await resposta.json().catch(() => null)) as
    | Record<string, unknown>
    | null;

  if (!corpo) return null;

  const dados = (corpo.data ?? corpo) as Record<string, unknown>;

  if (Array.isArray(dados)) {
    return (dados[0] as Record<string, unknown>) ?? null;
  }

  if (typeof dados.username === "string") return dados;

  if (dados.customer && typeof dados.customer === "object") {
    return dados.customer as Record<string, unknown>;
  }

  return null;
}

/** Cria um cliente pago no painel. */
export async function criarCliente(
  painel: Painel,
  pacoteId: string,
  telefone: string,
  nome: string,
  buscar: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  return await escrever(
    painel,
    "create",
    {
      userId: painel.painel_user_id,
      packageId: pacoteId,
      whatsapp: telefone,
      name: nome || telefone,
      /* A nota guarda o telefone: é por ela que se acha o cliente depois,
       * porque o usuário é gerado pelo painel e ninguém o decorou. */
      note: telefone,
    },
    buscar,
  );
}

/** Soma prazo a um cliente que já existe. */
export async function renovarCliente(
  painel: Painel,
  pacoteId: string,
  username: string,
  buscar: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  return await escrever(
    painel,
    "renew",
    { userId: painel.painel_user_id, username, packageId: pacoteId },
    buscar,
  );
}

async function escrever(
  painel: Painel,
  acao: "create" | "renew",
  corpo: Record<string, unknown>,
  buscar: typeof fetch,
): Promise<Record<string, unknown>> {
  const base = semBarra(painel.painel_url || painel.base_url);

  const resposta = await buscar(`${base}/webhook/customer/${acao}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${painel.token}`,
    },
    body: JSON.stringify(corpo),
    signal: AbortSignal.timeout(20_000),
  });

  const texto = await resposta.text();

  if (!resposta.ok) {
    throw new ErroDoPainel(resposta.status, texto.slice(0, 300));
  }

  const lido = JSON.parse(texto) as Record<string, unknown>;

  return (lido.data ?? lido) as Record<string, unknown>;
}
