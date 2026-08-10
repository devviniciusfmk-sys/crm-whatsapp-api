import type {
  AgentRow,
  AIAgentExtra,
  ContactRow,
  ConversationRow,
  MessageInsert,
  MessageRow,
  OrganizationRow,
} from "../../_shared/supabase.ts";

export type AgentRowWithExtra = Omit<AgentRow, "extra"> & {
  extra: AIAgentExtra;
};

/**
 * Teto de saída, quando o agente não define um.
 *
 * Sem isto o pedido ia sem `max_completion_tokens` e valia o padrão do
 * fornecedor — que na OpenRouter é 8192. Medido em 2026/08/07, três conversas
 * mortas pelo mesmo jeito:
 *
 *   deram certo    entrada ~2500 · raciocínio 11-50 · saída 40-94
 *   cortaram       entrada ~2600 · raciocínio 16    · saída 8192
 *
 * A entrada é a mesma e o raciocínio é minúsculo nos dois: não era contexto
 * grande nem raciocínio comendo o orçamento, que foram as duas hipóteses que
 * eu persegui. Oito mil e cento e noventa e dois é potência de dois — é teto
 * batido. O modelo entrou em fuga e gerou até bater na parede, sem produzir
 * texto nem chamada de ferramenta.
 *
 * Duas mil é vinte vezes a maior resposta observada e quatro vezes mais barato
 * que deixar a fuga correr até o fim: US$ 0,0003 em vez de US$ 0,0014, e a
 * segunda tentativa chega quatro vezes mais rápido ao contato.
 *
 * Subir este número por causa de um corte é o instinto errado, e foi o meu:
 * numa fuga, teto maior é só fuga maior. - 2026/08/07
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 2000;

/**
 * Os números de uma chamada ao modelo, com os nossos nomes.
 *
 * Cada protocolo os recebe com o nome dele — `prompt_tokens` num,
 * `input_tokens` no outro — e normaliza para cá. Quem lê a nota de silêncio não
 * deve precisar saber por qual protocolo o agente fala. - 2026/08/06
 */
export type CallUsage = {
  messages: number;
  tools: number;
  prompt: number;
  completion: number;
  reasoning: number;
};

/**
 * A nota de silêncio, com os números junto — a única forma de montar uma.
 *
 * O motivo sozinho diz o que aconteceu e não deixa investigar: foi contexto
 * grande demais? o raciocínio comeu o orçamento? sobrou espaço e mesmo assim
 * veio vazio? São perguntas diferentes, com consertos diferentes.
 *
 * É função, e não um texto montado em cada lugar, porque já aconteceu duas
 * vezes de uma nota nova nascer cega: a do corte por limite, e a do texto solto
 * que estava assim desde que os números existem. Enquanto montar a mão for
 * possível, a próxima também nasce. Aqui, esquecer não é uma opção — só se
 * chega ao texto passando pelos números. - 2026/08/06
 */
export function silenceNote(reason: string, usage?: CallUsage): string {
  if (!usage) return reason;

  return `${reason} (${usage.messages} mensagens, ${usage.tools} ferramentas, ${usage.prompt} tokens de entrada, ${usage.reasoning} de raciocínio, ${usage.completion} de saída)`;
}

/**
 * Marcas do canal de raciocínio e da sintaxe de ferramenta.
 *
 * O gpt-oss abre o raciocínio com `analysis` e separa a fala com
 * `assistantfinal`; alguns provedores devolvem o gabarito de chamada de
 * ferramenta cru. Qualquer uma delas presente é sinal de que aquilo NÃO é uma
 * resposta — é o miolo do modelo escapando.
 */
const MARCAS_DE_VAZAMENTO = [
  // Sem fim de palavra: no vazamento de verdade veio "analysisWe have a user",
  // colado. Com `\banalysis\b` o teste passou o vazamento inteiro — foi o
  // próprio teste que pegou, antes de subir. O começo de palavra fica, e é ele
  // que deixa "análise" em paz: a nossa tem acento.
  /\banalysis/i,
  /\bcommentary/i,
  /assistantfinal/i,
  /to=functions\./,
  /<\|/,
  /\btool_calls\b/,
  /"(name|arguments|parameters)"\s*:/,
  /\bfunction\s*\(/,
  /^\s*[{[]/,
];

/** Resposta de atendimento é curta. Monólogo é outra coisa. */
const TETO_DE_RESPOSTA = 1200;

/**
 * Se este texto solto pode ir ao cliente, como último recurso.
 *
 * Desde 2026/08/04 todo texto que chega por fora da ferramenta `respond` fica
 * interno, e a regra nasceu de um vazamento real: o raciocínio do modelo, em
 * inglês e com a sintaxe da chamada de ferramenta no meio, foi para o WhatsApp
 * de um cliente. A proteção está certa e continua.
 *
 * O que ela não previu foi o preço. Medido em 2026/08/10, num dia de movimento:
 * 5 clientes em 30 ficaram MUDOS, e nos três que abri o modelo tinha escrito a
 * resposta certa — "Um momento, estou transferindo sua conversa para um
 * colega", "Oi Rita, confirmei sua manicure na quarta (12/08) às 13h". Texto
 * limpo, no idioma certo, jogado fora. Nos três ele já havia chamado uma
 * ferramenta na MESMA rodada, então o canal funcionava: não era provedor
 * incapaz, era a última fala saindo solta.
 *
 * Então a proteção fica e ganha uma saída estreita. Só passa o que não tem
 * nenhuma marca de vazamento e é curto como uma resposta. Na dúvida, fica
 * interno — mandar o pensamento do modelo ao cliente é pior que o silêncio, e o
 * silêncio agora chama uma pessoa. - 2026/08/10
 */
export function podeIrAoCliente(texto: string): boolean {
  const limpo = texto.trim();

  if (!limpo || limpo.length > TETO_DE_RESPOSTA) return false;

  return !MARCAS_DE_VAZAMENTO.some((marca) => marca.test(limpo));
}

/**
 * O que este contato já tem marcado, buscado antes de montar o pedido.
 *
 * Vem de fora porque `buildRuntimeContext` é função pura e vale a pena mantê-la
 * assim — é a parte do sistema com testes de verdade. A consulta acontece onde
 * já existe cliente de banco. - 2026/08/07
 */
export type UpcomingAppointment = {
  title: string;
  starts_at: string;
  weekday: string;
  duration_minutes: number | null;
};

export interface RequestContext {
  organization: OrganizationRow;
  conversation: ConversationRow;
  messages: MessageRow[];
  contact?: ContactRow;
  agent: AgentRowWithExtra;
  appointments?: UpcomingAppointment[];
  /** Nomes de quem atende, quando a loja tem mais de uma cadeira. */
  professionals?: string[];
}

export interface ResponseContext {
  organization?: OrganizationRow;
  conversation?: ConversationRow;
  messages?: MessageInsert[];
  contact?: ContactRow;
  agent?: AgentRowWithExtra;
  /**
   * Por que esta rodada não produziu mensagem para o contato.
   *
   * O aviso de "não respondeu" já existia e já pegou um caso real — mas dizia
   * só que não houve resposta, não qual das duas coisas aconteceu: o modelo
   * chamar `respond` com lista vazia, ou terminar sem texto nenhum. As duas se
   * parecem de fora e pedem consertos diferentes, e sem distinguir sobra
   * adivinhação. O protocolo sabe qual foi; o laço só repete. - 2026/08/04
   */
  silence?: string;
}

export function contextHeaders(
  context: RequestContext,
): Record<string, string> {
  return {
    "organization-id": context.organization.id,
    "organization-address": context.conversation.organization_address,
    "conversation-id": context.conversation.id,
    "agent-id": context.agent.id,
    ...(context.contact?.id && { "contact-id": context.contact.id }),
    ...(context.conversation.contact_address &&
      { "contact-address": context.conversation.contact_address }),
  };
}

export interface AgentProtocolHandler<Request = unknown, Response = unknown> {
  prepareRequest(): Promise<Request>;

  sendRequest(request: Request): Promise<Response>;

  processResponse(response: Response): Promise<ResponseContext>;
}
