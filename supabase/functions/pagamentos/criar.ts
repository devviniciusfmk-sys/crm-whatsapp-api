/**
 * # Criar a cobrança no gateway
 *
 * O outro lado do postback. Ali o gateway avisa que pagaram; aqui pedimos a
 * ele que gere o Pix — um código dinâmico, com valor e vencimento, que ele
 * sabe reconhecer quando cair.
 *
 * ## Por que isto muda o produto
 *
 * A chave Pix estática que já enviamos funciona: o cliente copia, paga, e
 * alguém confere o extrato. O código dinâmico é o mesmo texto para o cliente —
 * o WhatsApp continua desenhando "⧉ Copiar código Pix" embaixo dele — mas o
 * gateway avisa sozinho quando o dinheiro entra. É a diferença entre a loja
 * conferir e a loja ser avisada.
 *
 * Nada aqui substitui a chave estática. Ela continua sendo o caminho de quem
 * não quer gateway nenhum, e é grátis. Este é o caminho de quem quer que a
 * confirmação chegue sozinha.
 *
 * ## O que este arquivo é
 *
 * Uma função pura sobre `fetch`: recebe dados, devolve o código Pix ou um
 * erro. Não conhece o banco, não conhece conversa, não manda mensagem. Isso é
 * de propósito — é o que deixa testá-la sem subir nada, e é o que faz um
 * gateway novo ser um arquivo novo em vez de uma cirurgia. - 2026/08/19
 */

/**
 * Quem vai pagar.
 *
 * ## Por que o documento é opcional aqui
 *
 * A documentação marca `document` como obrigatório e depois diz, na descrição
 * do próprio campo, que "é possível também omitir". Omitimos por padrão: numa
 * conversa de WhatsApp temos o telefone e o nome, e não o CPF — e inventar um
 * não é opção, porque CPF válido gerado ao acaso é, com boa probabilidade, o
 * documento de uma pessoa de verdade.
 *
 * Quando a loja tiver o CPF do cliente — pedido a ele, uma vez — ele entra e
 * vai junto. É o caminho recomendado pela AmploPay e o que evita dor depois.
 */
export type Pagador = {
  nome: string;
  email: string;
  telefone: string;
  /** Só quando o cliente informou. Ausente, o campo não é enviado. */
  documento?: string;
};

export type PedidoDeCobranca = {
  /**
   * A nossa referência, que volta no postback como `clientIdentifier`.
   *
   * Leva o prefixo `cob:` ou `fat:` — é ele que diz, na volta, se o dinheiro é
   * de um cliente da loja ou da mensalidade que a loja paga.
   */
  referencia: string;
  /** Em reais. Nunca em centavos: a AmploPay lê o número como está. */
  valor: number;
  pagador: Pagador;
  itens?: { nome: string; valor: number; quantidade?: number }[];
  /** `YYYY-MM-DD`. Depois disso o código para de valer. */
  vence?: string;
  /** Para onde o gateway avisa. Sem isto, o pagamento nunca volta. */
  avisarEm?: string;
};

export type CobrancaCriada = {
  /** O copia-e-cola. É isto que vai para o WhatsApp. */
  codigo: string;
  /** O id no gateway, para consultar depois. */
  transacao: string;
  /** URL da imagem do QR Code, quando o gateway devolve uma. */
  imagem?: string;
  /** Página de checkout, quando existe. */
  checkout?: string;
};

export type Credenciais = { publica: string; secreta: string };

export class ErroDoGateway extends Error {
  constructor(
    readonly gateway: string,
    readonly codigo: string,
    mensagem: string,
    readonly campo?: string,
  ) {
    super(mensagem);
    this.name = "ErroDoGateway";
  }
}

const BASE = "https://app.amplopay.com/api/v1";

/** O que a credencial é e o que ela pode. */
export type Credencial = {
  nome: string;
  /** Vazio com `todas` verdadeiro significa acesso total, e não nenhum. */
  permissoes: string[];
  todas: boolean;
  expiraEm: string | null;
  /** `false` quando falta a permissão de criar transações. */
  podeCobrar: boolean;
};

/**
 * Confere as chaves sem cobrar ninguém.
 *
 * ## Por que não basta "deu certo" ou "deu errado"
 *
 * A resposta traz o que a credencial PODE fazer, e é aí que mora o problema
 * real: uma chave válida sem `PRODUCER_TRANSACTIONS` autentica normalmente e
 * falha só na hora de criar a cobrança — com um cliente esperando do outro
 * lado. Um teste que respondesse apenas "conectou" aprovaria essa chave.
 *
 * `grantAllPermissions` com a lista vazia quer dizer acesso TOTAL, e não
 * nenhum. Ler a lista sem olhar essa bandeira reprovaria justamente a
 * credencial mais poderosa.
 */
export async function testarAmploPay(
  credenciais: Credenciais,
  buscar: typeof fetch = fetch,
): Promise<Credencial> {
  const resposta = await buscar(`${BASE}/gateway/producer/credentials`, {
    headers: {
      "x-public-key": credenciais.publica,
      "x-secret-key": credenciais.secreta,
    },
  });

  const dados = await resposta.json().catch(() => ({}));

  if (!resposta.ok) {
    throw new ErroDoGateway(
      "amplopay",
      String(dados?.errorCode ?? resposta.status),
      String(dados?.message ?? `o gateway respondeu ${resposta.status}`),
    );
  }

  const permissoes: string[] = Array.isArray(dados?.permissions)
    ? dados.permissions.map(String)
    : [];

  const todas = dados?.grantAllPermissions === true;

  return {
    nome: String(dados?.name ?? ""),
    permissoes,
    todas,
    expiraEm: dados?.expiresAt ?? null,
    podeCobrar: todas || permissoes.includes("PRODUCER_TRANSACTIONS"),
  };
}

/**
 * Telefone como a AmploPay espera.
 *
 * Guardamos `5511999998888` — com o 55 do país, que é como o WhatsApp
 * identifica. Eles querem `(11) 99999-8888`, o formato brasileiro sem país.
 * Mandar o nosso do jeito que está faz virar um DDD 55 que não existe.
 */
export function telefoneBR(bruto: string): string {
  const so = bruto.replace(/\D/g, "");
  const sem55 = so.startsWith("55") && so.length > 11 ? so.slice(2) : so;

  if (sem55.length < 10) return sem55;

  const ddd = sem55.slice(0, 2);
  const resto = sem55.slice(2);
  const meio = resto.length > 8 ? 5 : 4;

  return `(${ddd}) ${resto.slice(0, meio)}-${resto.slice(meio)}`;
}

/**
 * Pede o Pix à AmploPay.
 *
 * ## Sobre os erros
 *
 * `ErroDoGateway` carrega o campo que causou o problema, porque é isso que a
 * loja precisa ver. "Erro ao gerar Pix" manda ela abrir um chamado; "o CPF do
 * cliente está inválido" ela resolve em dez segundos.
 */
export async function criarPixAmploPay(
  pedido: PedidoDeCobranca,
  credenciais: Credenciais,
  buscar: typeof fetch = fetch,
): Promise<CobrancaCriada> {
  /* Vazio e ausente são a mesma coisa aqui: `document: ""` é um jeito conhecido
   * de um gateway recusar por validação, e a mensagem de erro nunca diz isso. */
  const documento = (pedido.pagador.documento ?? "").replace(/\D/g, "");

  const corpo = {
    identifier: pedido.referencia,
    amount: pedido.valor,
    client: {
      name: pedido.pagador.nome,
      email: pedido.pagador.email,
      phone: telefoneBR(pedido.pagador.telefone),
      ...(documento ? { document: documento } : {}),
    },
    ...(pedido.itens?.length
      ? {
        products: pedido.itens.map((i, n) => ({
          id: `${pedido.referencia}-${n}`,
          name: i.nome,
          quantity: i.quantidade ?? 1,
          price: i.valor,
        })),
      }
      : {}),
    ...(pedido.vence ? { dueDate: pedido.vence } : {}),
    ...(pedido.avisarEm ? { callbackUrl: pedido.avisarEm } : {}),
  };

  const resposta = await buscar(`${BASE}/gateway/pix/receive`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-public-key": credenciais.publica,
      "x-secret-key": credenciais.secreta,
    },
    body: JSON.stringify(corpo),
  });

  const dados = await resposta.json().catch(() => ({}));

  if (!resposta.ok) {
    throw new ErroDoGateway(
      "amplopay",
      String(dados?.errorCode ?? resposta.status),
      String(dados?.message ?? `o gateway respondeu ${resposta.status}`),
      dados?.details?.field,
    );
  }

  /* `status` é o da CRIAÇÃO, e não o do pagamento: `OK` quer dizer que o
   * código foi gerado, não que alguém pagou. Quem paga é o postback. Confundir
   * os dois faria toda cobrança nascer quitada. */
  if (dados?.status && dados.status !== "OK" && dados.status !== "PENDING") {
    throw new ErroDoGateway(
      "amplopay",
      String(dados.status),
      String(dados.errorDescription ?? `o gateway devolveu ${dados.status}`),
    );
  }

  const codigo = dados?.pix?.code;

  if (!codigo) {
    /* Sem o copia-e-cola não há o que mandar. Melhor falhar aqui do que enviar
     * ao cliente uma mensagem de cobrança sem código dentro. */
    throw new ErroDoGateway(
      "amplopay",
      "SEM_CODIGO",
      "o gateway aceitou a cobrança mas não devolveu o código Pix",
    );
  }

  return {
    codigo,
    transacao: String(dados.transactionId ?? ""),
    imagem: dados?.pix?.image || undefined,
    checkout: dados?.order?.url || undefined,
  };
}
