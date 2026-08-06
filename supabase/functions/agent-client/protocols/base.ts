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
 * Teto de saída da segunda tentativa, quando a primeira foi cortada no meio.
 *
 * Não é medida de tamanho de resposta: as nossas cabem em muito menos. É espaço
 * para o raciocínio caber junto com a chamada de `respond`, que é o que faltou
 * quando o corte aconteceu. Generoso de propósito — o custo de sobrar é alguns
 * tokens não usados, o custo de faltar é o contato sem resposta.
 *
 * Aqui, e não em cada protocolo, porque os dois falham do mesmo jeito e não faz
 * sentido um ceder antes do outro. - 2026/08/05
 */
export const CUT_SHORT_TOKEN_FLOOR = 4000;

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

export interface RequestContext {
  organization: OrganizationRow;
  conversation: ConversationRow;
  messages: MessageRow[];
  contact?: ContactRow;
  agent: AgentRowWithExtra;
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
