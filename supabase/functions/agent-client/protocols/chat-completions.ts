import OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionAssistantMessageParam,
  ChatCompletionMessage,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
  ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions";
import type {
  LocalToolInfo,
  MessageInsert,
  MessageRow,
  Part,
  ToolEventInfo,
  ToolInfo,
} from "../../_shared/supabase.ts";
import {
  type AgentProtocolHandler,
  contextHeaders,
  type RequestContext,
  type ResponseContext,
} from "./base.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentTool } from "../index.ts";
import * as log from "../../_shared/logger.ts";
import { getFileMetadata } from "../../_shared/media.ts";
import { serializePartAsXML } from "./serializer.ts";
import { buildRuntimeContext } from "./context.ts";
import { inspect } from "node:util";

const MULTI_MESSAGE_RESPONSE = true;
const RESPOND_FUNCTION_NAME = "respond";

export const RESPOND_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: RESPOND_FUNCTION_NAME,
    // A descrição antiga terminava em "Call with an empty messages array to
    // skip responding", e o modelo aceitava o convite: em três de cada cinco
    // saudações medidas ele chamou `respond` sem mensagem nenhuma. Do lado de
    // fora isso é o cliente escrevendo "Bom dia!" e ninguém respondendo — e
    // como nenhuma mensagem é gravada, não fica rastro de que houve decisão.
    // Calar estava oferecido como opção normal, então virou uma.
    //
    // Quem não deve responder tem outra saída, e essa deixa rastro:
    // transfer_to_human_agent. - 2026/08/04
    description:
      "Send messages to the customer. This is how you talk to them: call it with everything you want to say. The customer is waiting for an answer, so send at least one message — never call this with an empty list. If you should not be the one answering, use transfer_to_human_agent instead of staying silent.",
    parameters: {
      type: "object",
      properties: {
        messages: {
          // O esquema também recusa a lista vazia, para os provedores que o
          // aplicam: a descrição convence, o esquema impede.
          minItems: 1,
          type: "array",
          items: {
            anyOf: [
              {
                type: "object",
                properties: {
                  type: { type: "string", enum: ["text"] },
                  text: { type: "string" },
                },
                required: ["type", "text"],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: {
                  type: { type: "string", enum: ["file"] },
                  uri: { type: "string", description: "internal:// file URI" },
                  name: { type: "string" },
                  text: { type: "string", description: "Optional caption" },
                },
                required: ["type", "uri"],
                additionalProperties: false,
              },
            ],
          },
        },
      },
      additionalProperties: false,
    },
  },
};

export interface ChatCompletionsRequest {
  messages: ChatCompletionMessageParam[];
  tools: ChatCompletionTool[];
}

export interface ChatCompletionsResponse {
  finish_reason: ChatCompletion["choices"][number]["finish_reason"];
  message: ChatCompletionMessage;
  /**
   * O tamanho da chamada, para o aviso de silêncio poder dizer os números.
   *
   * O silêncio já diz o motivo, e mesmo assim não deu para achar a causa: cinco
   * hipóteses testadas de fora — provedor, histórico sujo, as próprias notas
   * internas no contexto, ferramentas do MCP, esforço de raciocínio — e todas
   * responderam 8 de 8 em bancada. O defeito só acontece dentro, e medir de
   * fora não alcança.
   *
   * Então o aviso passa a carregar o que só quem fez a chamada sabe: quantas
   * mensagens foram, quanto entrou, quanto o modelo pensou e quanto sobrou para
   * responder. Com isso, a próxima ocorrência é um diagnóstico em vez de mais
   * uma rodada de palpite. - 2026/08/05
   */
  usage?: {
    messages: number;
    tools: number;
    prompt: number;
    completion: number;
    reasoning: number;
  };
}

type RespondMessage =
  | { type: "text"; text: string }
  | { type: "file"; uri: string; name?: string; text?: string };

/**
 * O que o modelo mandou em `respond`, na forma que o resto do código espera.
 *
 * O esquema pede uma lista de `{type:"text", text}` e o modelo nem sempre
 * obedece. O leitor antigo exigia exatamente aquilo, e qualquer variação virava
 * "lista vazia" — que o sistema tratava como "não responder". Do lado de fora:
 * o cliente escreve e ninguém responde.
 *
 * Foi o que aconteceu em produção três vezes. Os números do aviso é que
 * denunciaram: 81 tokens de saída para uma suposta lista vazia, quando
 * `{"messages":[]}` custa oito. O modelo tinha escrito a resposta; o leitor é
 * que não a reconheceu.
 *
 * As formas aceitas aqui são as que aparecem na prática:
 *   "Bom dia"                          → texto solto no lugar da lista
 *   ["Bom dia", "tudo bem?"]           → lista de textos soltos
 *   {type:"text", text:"..."}          → uma mensagem fora de lista
 *   {content:"..."} / {message:"..."}  → a chave com outro nome
 *
 * Ser tolerante aqui não afrouxa nada: o que entra continua sendo texto do
 * modelo para o cliente, e o que não tiver texto nenhum continua sendo
 * silêncio, agora com o argumento cru no aviso para não sobrar dúvida.
 * - 2026/08/05
 */
export function coerceRespondMessages(raw: unknown): RespondMessage[] {
  const one = (item: unknown): RespondMessage | null => {
    if (typeof item === "string") {
      return item.trim() ? { type: "text", text: item } : null;
    }

    if (!item || typeof item !== "object") return null;

    const part = item as Record<string, unknown>;

    if (part.type === "file" && typeof part.uri === "string") {
      return {
        type: "file",
        uri: part.uri,
        name: typeof part.name === "string" ? part.name : undefined,
        text: typeof part.text === "string" ? part.text : undefined,
      };
    }

    // `text` é o nome do esquema; os outros são os apelidos que o modelo usa.
    const text = [part.text, part.content, part.message, part.body].find(
      (value): value is string => typeof value === "string" && !!value.trim(),
    );

    return text ? { type: "text", text } : null;
  };

  if (Array.isArray(raw)) {
    return raw.map(one).filter((item): item is RespondMessage => !!item);
  }

  const single = one(raw);

  return single ? [single] : [];
}

/**
 * Os números da chamada, em uma linha, para o aviso de silêncio.
 *
 * Sem eles a nota diz o que aconteceu e não deixa investigar: foi contexto
 * grande demais? o raciocínio comeu o orçamento? sobrou espaço e mesmo assim
 * veio vazio? São perguntas diferentes, com consertos diferentes. - 2026/08/05
 */
function describeUsage(usage?: ChatCompletionsResponse["usage"]): string {
  if (!usage) return "";

  return `(${usage.messages} mensagens, ${usage.tools} ferramentas, ${usage.prompt} tokens de entrada, ${usage.reasoning} de raciocínio, ${usage.completion} de saída)`;
}

export class ChatCompletionsHandler
  implements
    AgentProtocolHandler<ChatCompletionsRequest, ChatCompletionsResponse> {
  private tools: AgentTool[];
  private context: RequestContext;
  private client: SupabaseClient;
  private FUNCTION_NAME_SEPARATOR = "__";
  private messagesByExternalId = new Map<string, MessageRow>();

  constructor(
    tools: AgentTool[],
    context: RequestContext,
    client: SupabaseClient,
  ) {
    this.tools = tools;
    this.context = context;
    this.client = client;
  }

  /**
   * An assistant message with 'tool_calls' must be followed by
   * tool messages responding to each 'tool_call_id'.
   *
   * The problem is that the tool messages order is not guaranteed.
   */
  private sortToolMessages(messages: MessageRow[]): MessageRow[] {
    const taskMap = new Map<
      string,
      {
        uses: MessageRow[];
        results: MessageRow[];
      }
    >();

    const withoutTools: MessageRow[] = [];

    for (const row of messages) {
      if (row.direction === "internal" && row.content.tool) {
        const taskId = row.content.task?.id;

        if (!taskId) {
          throw new Error("Task id is required");
        }

        let task = taskMap.get(taskId);

        if (!task) {
          task = {
            uses: [],
            results: [],
          };

          taskMap.set(taskId, task);
        }

        if (row.content.tool.event === "use") {
          if (!task.uses.length) {
            // Use the first appeareance of a tool use within a task as a placeholder.
            withoutTools.push(row);
          }

          task.uses.push(row);
        } else {
          task.results.push(row);
        }

        continue;
      }

      withoutTools.push(row);
    }

    const sorted: MessageRow[] = [];

    for (const row of withoutTools) {
      if (row.direction === "internal" && row.content.tool) {
        const taskId = row.content.task!.id;

        const task = taskMap.get(taskId)!;

        sorted.push(...task.uses, ...task.results);

        continue;
      }

      sorted.push(row);
    }

    return sorted;
  }

  private removeOtherAgentsToolMessages(messages: MessageRow[]): MessageRow[] {
    return messages.filter((message) => {
      if (message.direction === "internal" && message.content.tool) {
        return message.agent_id === this.context.agent.id;
      }

      return true;
    });
  }

  private removeUnpairedToolMessages(messages: MessageRow[]): MessageRow[] {
    const toolUseSet = new Set<string>();
    const pairedToolUseSet = new Set<string>();

    for (const message of messages) {
      if (message.direction === "internal" && message.content.tool) {
        const toolUseId = message.content.tool.use_id;

        if (toolUseSet.has(toolUseId)) {
          pairedToolUseSet.add(toolUseId);
        } else {
          toolUseSet.add(toolUseId);
        }
      }
    }

    return messages.filter((message) => {
      if (message.direction === "internal" && message.content.tool) {
        return pairedToolUseSet.has(message.content.tool.use_id);
      }

      return true;
    });
  }

  /**
   * Expects tool messages to be sorted.
   */
  private mergeToolUseMessages(
    messages: MessageRow[],
  ): ChatCompletionMessageParam[] {
    const messageParams: ChatCompletionMessageParam[] = [];

    for (const row of messages) {
      const lastParam = messageParams.at(-1);

      const param = this.toChatCompletion(row);

      if (
        lastParam &&
        "tool_calls" in lastParam &&
        Array.isArray(lastParam.tool_calls) &&
        "tool_calls" in param &&
        Array.isArray(param.tool_calls)
      ) {
        lastParam.tool_calls.push(...param.tool_calls);

        continue;
      }

      messageParams.push(param);
    }

    return messageParams;
  }

  /**
   * Chat Completions does not keep the message history of the conversation.
   * That's why we do not send files but some text representation of them.
   * It would be costly to send the same files over and over again during the conversation.
   */
  private toChatCompletion(
    row: MessageRow,
  ): ChatCompletionMessageParam {
    const part = row.content as Part & ToolInfo;
    const role = row.agent_id === this.context.agent.id ? "assistant" : "user";

    if (part.tool?.provider === "local") {
      if (part.tool.event === "use") {
        const name = ["label" in part.tool && part.tool.label, part.tool.name]
          .filter(Boolean)
          .join(this.FUNCTION_NAME_SEPARATOR);

        if (part.type === "data") {
          const toolCall: ChatCompletionMessageToolCall = {
            id: part.tool.use_id,
            function: {
              name,
              arguments: JSON.stringify(part.data),
            },
            type: "function",
          };

          const message: ChatCompletionAssistantMessageParam = {
            role: "assistant",
            tool_calls: [toolCall],
          };

          return message;
        }

        if (part.type === "text") {
          const toolCall: ChatCompletionMessageToolCall = {
            id: part.tool.use_id,
            custom: {
              name,
              input: part.text,
            },
            type: "custom",
          };

          const message: ChatCompletionAssistantMessageParam = {
            role: "assistant",
            tool_calls: [toolCall],
          };

          return message;
        }
      }

      if (part.tool.event === "result") {
        if (part.type === "data") {
          const message: ChatCompletionToolMessageParam = {
            role: "tool",
            content: JSON.stringify(part.data),
            tool_call_id: part.tool.use_id,
          };

          return message;
        }

        if (part.type === "text") {
          const message: ChatCompletionToolMessageParam = {
            role: "tool",
            content: part.text,
            tool_call_id: part.tool.use_id,
          };

          return message;
        }
      }
    }

    let serialized = serializePartAsXML(part);

    if (row.content.re_message_id) {
      const refMessage = this.messagesByExternalId.get(
        row.content.re_message_id,
      );

      if (refMessage) {
        const tag = part.type === "text" && part.kind === "reaction"
          ? "in-reaction-to"
          : "in-reply-to";
        const snippet = serializePartAsXML(
          refMessage.content as Part & ToolInfo,
        );
        serialized = `<${tag}>${snippet}</${tag}>\n${serialized}`;
      }
    }

    return {
      role,
      content: serialized,
    };
  }

  prepareRequest(): Promise<ChatCompletionsRequest> {
    let { messages, agent } = this.context;

    const max = agent.extra.max_messages;

    if (max && messages.length > max) {
      // TODO: Watch out for tools/tasks requests and responses, it would make no sense to cut the message
      // history after the request and before the response.
      messages = messages.slice(-max);
    }

    // TODO: Commented out, waiting for multi-agent support.
    //messages = this.removeOtherAgentsToolMessages(messages);
    // TODO: remove tool messages of missing tool definitions (this.tools)?
    // They tend to confuse the model with unexpected tool calls.
    // Build external_id index for reply/reaction context resolution
    this.messagesByExternalId = new Map(
      messages
        .filter((m): m is MessageRow & { external_id: string } =>
          !!m.external_id
        )
        .map((m) => [m.external_id, m]),
    );

    messages = this.removeUnpairedToolMessages(messages);
    messages = this.sortToolMessages(messages);

    const chatCompletionMessages = this.mergeToolUseMessages(messages);

    const context = buildRuntimeContext(this.context);

    let content = inspect(context, {
      compact: false,
      depth: Infinity,
      colors: false,
    });

    if (agent.extra.instructions) {
      content = agent.extra.instructions + "\n\n" + content;
    }

    chatCompletionMessages.unshift({
      role: "system",
      content,
    });

    const chatCompletionTools: ChatCompletionTool[] = this.tools.map((
      tool,
    ) => ({
      type: "function" as const,
      function: {
        name: ["label" in tool && tool.label, tool.name]
          .filter(Boolean)
          .join(this.FUNCTION_NAME_SEPARATOR),
        description: tool.description,
        parameters: tool.inputSchema,
        /**
         * NOTE:
         * - For each object in the parameters schema, set `additionalProperties: false`.
         * - All fields in `properties` must be included in `required`.
         * - To denote optional fields, add `null` as a type option in the schema.
         * - Anthropic does not support (ignores) `strict` mode.
         */
        //strict: true,
      },
    }));

    if (MULTI_MESSAGE_RESPONSE) {
      chatCompletionTools.push(RESPOND_TOOL);
    }

    return Promise.resolve({
      messages: chatCompletionMessages,
      tools: chatCompletionTools,
    });
  }

  private calculateCost(
    usage: ChatCompletion["usage"],
    pricing: Record<string, number>,
    quantity: number,
  ): number {
    if (!usage) return 0;

    const prompt = usage.prompt_tokens ?? 0;
    const completion = usage.completion_tokens ?? 0;
    const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
    const audio_in = usage.prompt_tokens_details?.audio_tokens ?? 0;
    const audio_out = usage.completion_tokens_details?.audio_tokens ?? 0;
    const reasoning = usage.completion_tokens_details?.reasoning_tokens ?? 0;

    const cost = (prompt - cached - audio_in) * (pricing.input ?? 0) +
      cached * (pricing.cache_read ?? pricing.input ?? 0) +
      audio_in * (pricing.audio_input ?? pricing.input ?? 0) +
      (completion - reasoning - audio_out) * (pricing.output ?? 0) +
      reasoning * (pricing.reasoning ?? pricing.output ?? 0) +
      audio_out * (pricing.audio_output ?? pricing.output ?? 0);

    return cost / quantity;
  }

  async sendRequest(
    request: ChatCompletionsRequest,
  ): Promise<ChatCompletionsResponse> {
    const { agent, organization } = this.context;

    let provider = agent.extra.api_url;
    let baseURL = agent.extra.api_url;
    let apiKey = agent.extra.api_key;
    let model = agent.extra.model;

    switch (baseURL) {
      case "groq":
        baseURL = "https://api.groq.com/openai/v1";
        apiKey ||= Deno.env.get("GROQ_API_KEY");
        model ||= "openai/gpt-oss-20b";
        break;
      case "anthropic":
        baseURL = "https://api.anthropic.com/v1";
        apiKey ||= Deno.env.get("ANTHROPIC_API_KEY");
        model ||= "claude-sonnet-4-6";
        break;
      case "google":
        baseURL = "https://generativelanguage.googleapis.com/v1beta/openai";
        apiKey ||= Deno.env.get("GOOGLE_API_KEY");
        model ||= "gemini-3-flash-preview";
        break;
      case "openai":
        // undefined makes OpenAI use the default base URL
        // and api key from the OPENAI_API_KEY environment variable.
        baseURL = undefined;
      /* falls through */
      default:
        // remove /chat/completions from the base URL if it exists,
        // the client appends it automatically.
        baseURL = baseURL?.replace("/chat/completions", "") || undefined;
        apiKey ||= undefined;
        model ||= "gpt-5-mini";
        provider = !!baseURL && baseURL !== "openai" ? "custom" : "openai";
    }
    // Note: for Bedrock, the base URL is https://${bedrock-runtime-endpoint}/openai/v1

    const billable = !agent.extra.api_key;

    // Fetch cost pricing before the LLM call
    const { data: costs } = await this.client
      .schema("billing")
      .from("costs")
      .select("pricing, quantity")
      .eq("provider", provider)
      .eq("product", model)
      .lte("effective_at", new Date().toISOString())
      .order("effective_at", { ascending: false })
      .limit(1)
      .maybeSingle()
      .throwOnError();

    if (billable) {
      // Block if we don't have pricing for this model
      if (!costs) {
        throw new Error(`No pricing found for ${provider}/${model}`);
      }

      // Check AI credits balance
      await this.client
        .schema("billing")
        .rpc("check_limit", {
          _organization_id: organization.id,
          _product_id: "ai_credits",
          _amount: 0,
        })
        .throwOnError();
    }

    const openai = new OpenAI({
      baseURL,
      apiKey,
      timeout: 30000, // 30 seconds
      maxRetries: 2,
      defaultHeaders: contextHeaders(this.context),
    });

    let response;

    let retries = 0;
    const maxRetries = 3;

    /**
     * Quem serve o modelo, quando o intermediário é a OpenRouter.
     *
     * Não é ajuste fino: o mesmo `openai/gpt-oss-120b`, na mesma requisição,
     * medido em 8 chamadas por provedor no dia 2026/08/04 —
     *
     *   Cerebras   8 de 8 certas, 0,3 s
     *   Together   7 de 8
     *   Groq       5 de 8 (3 vezes não chamou ferramenta nenhuma)
     *   Nebius     0 de 8: 2 com argumentos corrompidos, 6 sem ferramenta
     *   Phala      8 erros do provedor
     *
     * Os argumentos corrompidos do Nebius são o mesmo `"2023….....…????…"` que
     * chegou numa conversa de produção e fez o assistente tentar cancelar um
     * compromisso que ninguém pediu. `require_parameters` não salva: o Nebius
     * *anuncia* suporte a `tool_choice` e ainda assim devolve isso.
     *
     * Então o provedor é escolha, não sorteio. `agent.extra.provider` vai
     * verbatim para a OpenRouter (`order`, `only`, `ignore`, `sort` — o que a
     * documentação deles aceitar). Sem configuração, pede o mais rápido, que
     * empurra para o lado bom da tabela sem casar o produto com um fornecedor.
     *
     * Ignorado por qualquer outro provedor: é um campo extra num corpo JSON.
     * - 2026/08/04
     */
    const isOpenRouter = String(baseURL).includes("openrouter.ai");
    const providerRouting = isOpenRouter
      ? (agent.extra.provider ?? { sort: "throughput" })
      : undefined;

    /**
     * Quanto o modelo pode pensar antes de responder.
     *
     * O parâmetro estava escrito e comentado aqui desde sempre, então nunca
     * saiu: modelo de raciocínio como o gpt-oss vinha pensando no padrão dele.
     * O preço apareceu em produção como `finish_reason: "length"` — o
     * raciocínio consumiu o orçamento inteiro de saída e não sobrou nada para a
     * resposta. O cliente escreveu "gostaria de marcar uma consulta para dia
     * 30" e não recebeu nada.
     *
     * Medido na mesma pergunta: sem esforço declarado, 39 a 128 tokens de
     * raciocínio; com `low`, 21 a 30. Quatro vezes menos, com a mesma escolha
     * de ferramenta e o mesmo tempo de resposta.
     *
     * `low` como padrão porque isto é atendimento: turnos curtos, decisões
     * simples, e o que custa caro é a demora. Quem precisar de mais muda em
     * `extra.thinking`, que já existia na tela e não chegava a lugar nenhum.
     *
     * Pela chave `reasoning` na OpenRouter, que normaliza entre modelos e
     * ignora em quem não raciocina; pelo `reasoning_effort` da OpenAI nos
     * demais. - 2026/08/04
     */
    const effort = agent.extra.thinking ?? "low";
    const thinking = isOpenRouter
      ? { reasoning: { effort } }
      : { reasoning_effort: effort };

    while (true) {
      try {
        response = await openai.chat.completions.create({
          model,
          temperature: agent.extra.temperature ?? undefined,
          max_completion_tokens: agent.extra.max_tokens ?? undefined,
          ...(providerRouting ? { provider: providerRouting } : {}),
          messages: request.messages,
          // TOOLS
          tools: request.tools.length ? request.tools : undefined,
          tool_choice: MULTI_MESSAGE_RESPONSE ? "required" : undefined,
          parallel_tool_calls: request.tools.length ? true : undefined,
          // THINKING
          ...thinking,
        });

        break;
      } catch (error) {
        if (
          retries < maxRetries &&
          error instanceof Error &&
          "status" in error &&
          error.status === 400
        ) {
          log.warn(`Retrying with error context... ${error.message}`);

          // Create a defensive copy of messages to ensure we don't mutate the original request
          const messages = [...request.messages];

          messages.push({
            role: "user", // Phantom message
            content: `Previous request failed with error: ${error.message}`,
          });

          // Update the request reference to use the new messages array for the next iteration
          request = { ...request, messages };

          retries++;
          continue;
        }

        throw error;
      }
    }

    // Record AI usage in the ledger
    if (response.usage) {
      const cost = costs
        ? this.calculateCost(
          response.usage,
          costs.pricing as Record<string, number>,
          costs.quantity,
        )
        : 0;

      await this.client
        .schema("billing")
        .from("ledger")
        .insert({
          organization_id: organization.id,
          product_id: "ai_credits",
          type: "consumption",
          quantity: -cost,
          agent_id: agent.id,
          provider,
          model,
          billable,
          metadata: response.usage,
        })
        .throwOnError();
    }

    // Nem toda resposta 200 traz uma resposta. Há provedor que devolve o erro
    // dentro do corpo, com `choices` ausente, e `choices[0]` estourava
    // "Cannot read properties of undefined (reading '0')" — que era o que
    // chegava na conversa, sem dizer nada a ninguém. Apareceu ao trocar o
    // modelo para um servido pela Groq, e custou uma investigação inteira para
    // descobrir que não era a agenda nem o modelo, era o corpo da resposta.
    // - 2026/08/03
    const choice = response.choices?.[0];

    if (!choice) {
      const detail =
        (response as unknown as { error?: { message?: string } }).error
          ?.message ?? JSON.stringify(response).slice(0, 300);

      throw new Error(`The model returned no answer: ${detail}`);
    }

    return {
      finish_reason: choice.finish_reason,
      message: choice.message,
      usage: {
        messages: request.messages.length,
        tools: request.tools.length,
        prompt: response.usage?.prompt_tokens ?? 0,
        completion: response.usage?.completion_tokens ?? 0,
        reasoning:
          response.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
      },
    };
  }

  private async processRespondCall(
    respondCall: ChatCompletionMessageToolCall,
  ): Promise<MessageInsert[]> {
    const { agent, conversation } = this.context;

    if (respondCall.type !== "function") {
      return [];
    }

    const args = JSON.parse(respondCall.function.arguments) as {
      messages: Array<
        | { type: "text"; text: string }
        | { type: "file"; uri: string; name?: string; text?: string }
      >;
    };

    // Aceita as formas que o modelo insiste em usar, além da que o esquema pede.
    args.messages = coerceRespondMessages(
      (args as { messages?: unknown }).messages,
    );

    if (!args.messages?.length) {
      // Aviso, e não informação: se chegou aqui, o modelo ignorou a descrição e
      // o `minItems`, e o contato ficou sem resposta. O laço grava a nota na
      // conversa; isto é para quem for ler o log depois entender o porquê.
      log.warn(
        "Respond called with an empty list. The contact was left without an answer.",
      );
      return [];
    }

    const outgoing: MessageInsert[] = [];

    for (const msg of args.messages) {
      if (msg.type === "text") {
        outgoing.push({
          organization_id: conversation.organization_id,
          service: conversation.service,
          organization_address: conversation.organization_address,
          contact_address: conversation.contact_address,
          direction: "outgoing",
          agent_id: agent.id,
          content: {
            version: "1",
            type: "text",
            kind: "text",
            text: msg.text,
          },
        });
      } else if (msg.type === "file") {
        const file = await getFileMetadata(this.client, msg.uri);

        if (msg.name) {
          file.name = msg.name;
        }

        const mimePrefix = file.mime_type.split("/")[0];
        const kind = (
          ["audio", "image", "video"].includes(mimePrefix)
            ? mimePrefix
            : "document"
        ) as "audio" | "image" | "video" | "document";

        outgoing.push({
          organization_id: conversation.organization_id,
          service: conversation.service,
          organization_address: conversation.organization_address,
          contact_address: conversation.contact_address,
          direction: "outgoing",
          agent_id: agent.id,
          content: {
            version: "1",
            type: "file",
            kind,
            file,
            text: msg.text,
          },
        });
      }
    }

    return outgoing;
  }

  async processResponse(
    response: ChatCompletionsResponse,
  ): Promise<ResponseContext> {
    const { finish_reason, message } = response;
    const { agent, conversation } = this.context;

    if (finish_reason === "tool_calls" && message.tool_calls?.length) {
      // Check for the virtual respond tool call
      const respondCall = message.tool_calls.find(
        (tc) =>
          tc.type === "function" && tc.function.name === RESPOND_FUNCTION_NAME,
      );

      if (respondCall) {
        const messages = await this.processRespondCall(respondCall);

        return {
          messages,
          ...(messages.length ? {} : {
            // Com o argumento cru junto: depois de tolerar todas as formas
            // conhecidas, o que sobrar aqui é forma nova — e adivinhar qual
            // seria começar de novo a investigação que já custou dois dias.
            silence: `o modelo chamou \`respond\` e não veio texto nenhum ${
              describeUsage(response.usage)
            }. O que ele mandou: ${
              (respondCall.type === "function"
                ? respondCall.function.arguments
                : "").slice(0, 400)
            }`,
          }),
        };
      }

      // Regular tool calls — existing logic
      const taskId = crypto.randomUUID();

      const messages = message.tool_calls.map((toolCall): MessageInsert => {
        let tool: ToolEventInfo & LocalToolInfo;
        let name: string;
        let text: string;

        if (toolCall.type === "custom") {
          name = toolCall.custom.name;
          text = toolCall.custom.input;
        } else {
          name = toolCall.function.name;
          text = toolCall.function.arguments;
        }

        if (name.includes(this.FUNCTION_NAME_SEPARATOR)) {
          const [label, _name] = name.split(this.FUNCTION_NAME_SEPARATOR);

          const toolInfo = this.tools.find(
            (t) => t.label === label && t.name === _name,
          );

          tool = {
            use_id: toolCall.id,
            event: "use",
            provider: "local",
            // Default: Pick any type. Function name check is performed elsewhere.
            type: (toolInfo?.type || "mcp") as "mcp" | "sql" | "http",
            label,
            name: _name,
          };
        } else {
          const toolInfo = this.tools.find((t) => t.name === name);

          tool = {
            use_id: toolCall.id,
            event: "use",
            provider: "local",
            type: (toolInfo?.type as "function" | "custom") || "function",
            name,
          };
        }

        return {
          organization_id: conversation.organization_id,
          service: conversation.service,
          organization_address: conversation.organization_address,
          contact_address: conversation.contact_address,
          direction: "internal" as const,
          agent_id: agent.id,
          content: {
            version: "1" as const,
            task: {
              // This id will be used to merge all the tool calls together
              // in one single message during prepareRequest().
              id: taskId,
            },
            tool: tool!,
            type: "text" as const,
            kind: "text" as const,
            // Note: Function arguments are parsed during tool handling.
            // TODO: custom tool input is text (do not parse).
            text,
          },
        };
      });

      return {
        messages,
      };
    }

    // TODO: finish reasons: length, content filter

    /**
     * Texto solto quando a ferramenta era obrigatória: não vai para o cliente.
     *
     * Este atalho existia para modelos que ignoram `tool_choice` e respondem em
     * texto — e mandava esse texto ao contato. Em produção ele entregou isto,
     * e o cliente leu:
     *
     *   "analysisWe have a user wanting to schedule a consulta for day 30.
     *    They said 'dia 30'. Probably referring to August 30... Let's check
     *    if Monday 31 is open.assistantcommentary to=functions.list_appointments
     *    json{"date":"2026-08-31"}"
     *
     * É o formato de canais do gpt-oss (`analysis`, `commentary`, `final`)
     * chegando cru, sem o provedor ter separado o raciocínio da resposta. O
     * atalho não tinha como saber disso — para ele era só `content` — e
     * despachou o pensamento do modelo, em inglês, com a sintaxe da chamada de
     * ferramenta no meio, para o WhatsApp de um cliente.
     *
     * Com `tool_choice` obrigatório, o único caminho autorizado até o contato é
     * a ferramenta `respond`. Texto que chega por fora dela não é resposta: é
     * defeito. Fica gravado como mensagem interna, para quem atende ver o que o
     * modelo disse e poder responder à mão, e não sai daqui.
     *
     * Sem `tool_choice` obrigatório o atalho continua valendo: ali o texto é a
     * resposta mesmo. - 2026/08/04
     */
    if (finish_reason === "stop" && message.content && MULTI_MESSAGE_RESPONSE) {
      log.warn(
        "Model answered with loose text while tool_choice was required. Kept internal.",
      );

      return {
        messages: [
          {
            organization_id: conversation.organization_id,
            service: conversation.service,
            organization_address: conversation.organization_address,
            contact_address: conversation.contact_address,
            direction: "internal" as const,
            agent_id: agent.id,
            content: {
              version: "1" as const,
              type: "text" as const,
              kind: "text" as const,
              text:
                `O modelo respondeu em texto solto em vez de usar a ferramenta de resposta, então nada foi enviado ao contato. O que ele produziu:\n\n${message.content}`,
            },
          },
        ],
        silence:
          "o modelo respondeu em texto solto em vez de chamar `respond`; o texto ficou interno para não ir ao cliente",
      };
    }

    if (finish_reason === "stop" && message.content) {
      return {
        messages: [
          {
            organization_id: conversation.organization_id,
            service: conversation.service,
            organization_address: conversation.organization_address,
            contact_address: conversation.contact_address,
            direction: "outgoing",
            agent_id: agent.id,
            content: {
              version: "1",
              type: "text",
              kind: "text",
              text: message.content,
            },
          },
        ],
      };
    }

    return {
      messages: [],
      silence:
        `o modelo terminou com finish_reason "${finish_reason}" e sem texto, mesmo com tool_choice obrigatório ${
          describeUsage(response.usage)
        }`,
    };
  }
}
