import OpenAI from "openai";
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
  type CallUsage,
  contextHeaders,
  DEFAULT_MAX_OUTPUT_TOKENS,
  podeIrAoCliente,
  type RequestContext,
  type ResponseContext,
  silenceNote,
} from "./base.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentTool } from "../index.ts";
import * as log from "../../_shared/logger.ts";
import { getFileMetadata } from "../../_shared/media.ts";
import { serializePartAsXML } from "./serializer.ts";
import { buildRuntimeContext } from "./context.ts";
import { inspect } from "node:util";

// Handler for the Open Responses protocol (https://openresponses.org), the
// standardized, multi-vendor successor to OpenAI's Responses API. Mirrors
// ChatCompletionsHandler; the differences are that Responses represents each
// tool call as its own `function_call` input item (no merging), tool results as
// `function_call_output` items keyed by `call_id`, and returns an array of
// output items instead of a single message.
//
// Like the chat-completions handler, this is STATELESS: the full conversation
// is rebuilt from the DB on every turn and passed as `input` (no
// `previous_response_id` / server-side state), matching the agent-client loop.

// Convenience aliases for the OpenAI SDK's Responses namespace (avoids adding
// import-map entries for openai/resources/responses).
type ResponseInputItem = OpenAI.Responses.ResponseInputItem;
type ResponseOutputItem = OpenAI.Responses.ResponseOutputItem;
type ResponsesTool = OpenAI.Responses.Tool;
type FunctionCallItem = OpenAI.Responses.ResponseFunctionToolCall;
type ResponsesResponse = OpenAI.Responses.Response;

const MULTI_MESSAGE_RESPONSE = true;
const RESPOND_FUNCTION_NAME = "respond";

const RESPOND_TOOL: ResponsesTool = {
  type: "function",
  name: RESPOND_FUNCTION_NAME,
  // Mesma correção do protocolo chat-completions, pelo mesmo motivo medido:
  // oferecer o silêncio como opção fazia o modelo escolhê-lo. - 2026/08/04
  description:
    "Send messages to the customer. This is how you talk to them: call it with everything you want to say. The customer is waiting for an answer, so send at least one message — never call this with an empty list. If you should not be the one answering, use transfer_to_human_agent instead of staying silent.",
  strict: false,
  parameters: {
    type: "object",
    properties: {
      messages: {
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
};

export interface ResponsesRequest {
  input: ResponseInputItem[];
  tools: ResponsesTool[];
  instructions: string;
}

export interface ResponsesResponseWrapper {
  output: ResponseOutputItem[];
  /**
   * Cortado pelo limite de saída, e a segunda tentativa também não coube. O
   * `status` da resposta não sobrevive a este embrulho, e sem ele o silêncio
   * chegaria à conversa sem motivo nenhum. - 2026/08/05
   */
  cutShort?: boolean;
  /**
   * Os números da chamada, na mesma forma que o `chat_completions` guarda —
   * nomes nossos, e não os do protocolo, porque a nota que a pessoa lê é a
   * mesma nos dois. Aqui vêm de `input_tokens`/`output_tokens`, com o
   * raciocínio no `output_tokens_details`. - 2026/08/06
   */
  usage?: CallUsage;
}

export class ResponsesHandler
  implements AgentProtocolHandler<ResponsesRequest, ResponsesResponseWrapper> {
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
   * A tool-use item must be followed by its matching tool-result item. The
   * result rows are not guaranteed to arrive in order, so group each task's
   * uses before its results.
   */
  private sortToolMessages(messages: MessageRow[]): MessageRow[] {
    const taskMap = new Map<
      string,
      { uses: MessageRow[]; results: MessageRow[] }
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
          task = { uses: [], results: [] };
          taskMap.set(taskId, task);
        }

        if (row.content.tool.event === "use") {
          if (!task.uses.length) {
            // First appearance of a use within a task acts as a placeholder.
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
   * Map one stored message row to a Responses input item.
   *
   * Unlike Chat Completions (which merges parallel tool calls into a single
   * assistant message), Responses represents each tool call as its own
   * `function_call` item and each result as a `function_call_output` item, both
   * keyed by `call_id`. History is text-only (no re-sent files) to keep the
   * request cheap over a long conversation.
   */
  private toResponseInput(row: MessageRow): ResponseInputItem {
    const part = row.content as Part & ToolInfo;
    const role = row.agent_id === this.context.agent.id ? "assistant" : "user";

    if (part.tool?.provider === "local") {
      const name = ["label" in part.tool && part.tool.label, part.tool.name]
        .filter(Boolean)
        .join(this.FUNCTION_NAME_SEPARATOR);

      if (part.tool.event === "use") {
        const args = part.type === "data"
          ? JSON.stringify(part.data)
          : part.type === "text"
          ? part.text
          : "";

        return {
          type: "function_call",
          call_id: part.tool.use_id,
          name,
          arguments: args,
        };
      }

      if (part.tool.event === "result") {
        const output = part.type === "data"
          ? JSON.stringify(part.data)
          : part.type === "text"
          ? part.text
          : "";

        return {
          type: "function_call_output",
          call_id: part.tool.use_id,
          output,
        };
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

    return { role, content: serialized };
  }

  prepareRequest(): Promise<ResponsesRequest> {
    let { messages, agent } = this.context;

    const max = agent.extra.max_messages;

    if (max && messages.length > max) {
      messages = messages.slice(-max);
    }

    // Build external_id index for reply/reaction context resolution.
    this.messagesByExternalId = new Map(
      messages
        .filter((m): m is MessageRow & { external_id: string } =>
          !!m.external_id
        )
        .map((m) => [m.external_id, m]),
    );

    messages = this.removeUnpairedToolMessages(messages);
    messages = this.sortToolMessages(messages);

    const input: ResponseInputItem[] = messages.map((row) =>
      this.toResponseInput(row)
    );

    // Runtime context, delivered via the `instructions` field (the Responses
    // analog of Chat Completions' leading system message).
    const contextInfo = buildRuntimeContext(this.context);

    let instructions = inspect(contextInfo, {
      compact: false,
      depth: Infinity,
      colors: false,
    });

    if (agent.extra.instructions) {
      instructions = agent.extra.instructions + "\n\n" + instructions;
    }

    const tools: ResponsesTool[] = this.tools.map((tool) => ({
      type: "function" as const,
      name: ["label" in tool && tool.label, tool.name]
        .filter(Boolean)
        .join(this.FUNCTION_NAME_SEPARATOR),
      description: tool.description,
      strict: false,
      parameters: tool.inputSchema as Record<string, unknown>,
    }));

    if (MULTI_MESSAGE_RESPONSE) {
      tools.push(RESPOND_TOOL);
    }

    return Promise.resolve({ input, tools, instructions });
  }

  private calculateCost(
    usage: ResponsesResponse["usage"],
    pricing: Record<string, number>,
    quantity: number,
  ): number {
    if (!usage) return 0;

    // Responses usage shape differs from Chat Completions: input_tokens /
    // output_tokens, with cached and reasoning in the *_tokens_details.
    const prompt = usage.input_tokens ?? 0;
    const completion = usage.output_tokens ?? 0;
    const cached = usage.input_tokens_details?.cached_tokens ?? 0;
    const reasoning = usage.output_tokens_details?.reasoning_tokens ?? 0;

    const cost = (prompt - cached) * (pricing.input ?? 0) +
      cached * (pricing.cache_read ?? pricing.input ?? 0) +
      (completion - reasoning) * (pricing.output ?? 0) +
      reasoning * (pricing.reasoning ?? pricing.output ?? 0);

    return cost / quantity;
  }

  async sendRequest(
    request: ResponsesRequest,
  ): Promise<ResponsesResponseWrapper> {
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
      case "openai":
        // undefined makes OpenAI use the default base URL and the api key from
        // the OPENAI_API_KEY environment variable.
        baseURL = undefined;
      /* falls through */
      default:
        // Strip a trailing /responses if present; the client appends it.
        baseURL = baseURL?.replace("/responses", "") || undefined;
        apiKey ||= undefined;
        model ||= "gpt-5-mini";
        provider = !!baseURL && baseURL !== "openai" ? "custom" : "openai";
    }

    const billable = !agent.extra.api_key;

    // Fetch cost pricing before the LLM call.
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
      if (!costs) {
        throw new Error(`No pricing found for ${provider}/${model}`);
      }

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
      timeout: 30000,
      maxRetries: 2,
      defaultHeaders: contextHeaders(this.context),
    });

    let response: ResponsesResponse;

    let retries = 0;
    const maxRetries = 3;
    let input = request.input;

    /**
     * Quanto o modelo pode pensar antes de responder, e o que fazer quando não
     * couber.
     *
     * O `chat-completions.ts` ganhou isto em 2026/08/04, depois de o raciocínio
     * consumir o orçamento inteiro de saída em produção e o contato ficar sem
     * resposta. Este arquivo ficou de fora e seguia mandando modelo de
     * raciocínio pensar no padrão dele — mesma exposição, protocolo diferente.
     *
     * Aqui o corte aparece como `status: "incomplete"` com
     * `incomplete_details.reason: "max_output_tokens"`, num HTTP 200 — o laço
     * abaixo só retenta exceção com status 400, então passava reto.
     *
     * Uma segunda tentativa, com o esforço no mínimo e o teto elevado, e só
     * depois o silêncio. - 2026/08/05
     */
    const effort = agent.extra.thinking ?? "low";
    const maxTokens = agent.extra.max_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    let widened = false;
    let sendReasoning = true;
    const discarded: NonNullable<ResponsesResponse["usage"]>[] = [];

    while (true) {
      try {
        response = await openai.responses.create({
          model,
          instructions: request.instructions,
          input,
          temperature: agent.extra.temperature ?? undefined,
          max_output_tokens: maxTokens,
          tools: request.tools.length ? request.tools : undefined,
          tool_choice: MULTI_MESSAGE_RESPONSE ? "required" : undefined,
          parallel_tool_calls: request.tools.length ? true : undefined,
          store: false,
          ...(sendReasoning ? { reasoning: { effort } } : {}),
        });
      } catch (error) {
        // Modelo que não raciocina recusa o parâmetro. Tirar e repetir uma vez,
        // em vez de queimar as três tentativas mandando o que ele não aceita —
        // e em vez de deixar o contato sem resposta por causa de um campo que
        // nem se aplica a ele. - 2026/08/05
        if (
          sendReasoning &&
          error instanceof Error &&
          "status" in error &&
          error.status === 400 &&
          /reasoning/i.test(error.message)
        ) {
          sendReasoning = false;

          log.warn(
            "The model rejected the reasoning parameter. Retrying without it.",
          );

          continue;
        }

        if (
          retries < maxRetries &&
          error instanceof Error &&
          "status" in error &&
          error.status === 400
        ) {
          log.warn(`Retrying with error context... ${error.message}`);

          input = [
            ...input,
            {
              role: "user", // Phantom message
              content: `Previous request failed with error: ${error.message}`,
            },
          ];

          retries++;
          continue;
        }

        throw error;
      }

      // Cortado pelo limite e sem nada aproveitável. Com uma chamada de
      // ferramenta na mão o corte não custou a resposta, e mexer aqui só
      // atrasaria o contato.
      if (
        !widened &&
        response.status === "incomplete" &&
        response.incomplete_details?.reason === "max_output_tokens" &&
        !response.output.some((item) => item.type === "function_call")
      ) {
        widened = true;

        if (response.usage) discarded.push(response.usage);

        // Sem raciocínio e sem subir o teto, pelo mesmo motivo medido no
        // chat_completions: o corte era fuga, não aperto, e teto maior numa
        // fuga é só fuga maior. - 2026/08/07
        sendReasoning = false;

        log.warn(
          "Cut short by the output limit with nothing to send. Retrying without reasoning.",
        );

        continue;
      }

      break;
    }

    // Record AI usage in the ledger.
    //
    // A tentativa descartada gastou tokens de verdade: o provedor cobra o
    // raciocínio que não virou resposta. Somar as duas, senão a retentativa
    // vira consumo invisível na conta da organização. - 2026/08/05
    const usages = [...discarded, ...(response.usage ? [response.usage] : [])];

    if (usages.length) {
      const cost = costs
        ? usages.reduce(
          (sum, usage) =>
            sum +
            this.calculateCost(
              usage,
              costs.pricing as Record<string, number>,
              costs.quantity,
            ),
          0,
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
          metadata: discarded.length
            ? { ...response.usage, discarded_attempts: discarded }
            : response.usage,
        })
        .throwOnError();
    }

    return {
      output: response.output,
      cutShort: response.status === "incomplete" &&
        response.incomplete_details?.reason === "max_output_tokens",
      usage: {
        messages: request.input.length,
        tools: request.tools.length,
        prompt: response.usage?.input_tokens ?? 0,
        completion: response.usage?.output_tokens ?? 0,
        reasoning: response.usage?.output_tokens_details?.reasoning_tokens ?? 0,
      },
    };
  }

  private async processRespondCall(
    respondCall: FunctionCallItem,
  ): Promise<MessageInsert[]> {
    const { agent, conversation } = this.context;

    const args = JSON.parse(respondCall.arguments) as {
      messages: Array<
        | { type: "text"; text: string }
        | { type: "file"; uri: string; name?: string; text?: string }
      >;
    };

    if (!args.messages?.length) {
      log.info("Respond called with empty messages. No response to user.");
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
    response: ResponsesResponseWrapper,
  ): Promise<ResponseContext> {
    const { agent, conversation } = this.context;

    const functionCalls = response.output.filter(
      (item): item is FunctionCallItem => item.type === "function_call",
    );

    if (functionCalls.length) {
      // The virtual respond tool call, if present.
      const respondCall = functionCalls.find(
        (fc) => fc.name === RESPOND_FUNCTION_NAME,
      );

      if (respondCall) {
        const messages = await this.processRespondCall(respondCall);
        return { messages };
      }

      // Regular tool calls. Share one task id so prepareRequest can group the
      // parallel calls together.
      const taskId = crypto.randomUUID();

      const messages = functionCalls.map((toolCall): MessageInsert => {
        let tool: ToolEventInfo & LocalToolInfo;
        const name = toolCall.name;
        const text = toolCall.arguments;

        if (name.includes(this.FUNCTION_NAME_SEPARATOR)) {
          const [label, _name] = name.split(this.FUNCTION_NAME_SEPARATOR);

          const toolInfo = this.tools.find(
            (t) => t.label === label && t.name === _name,
          );

          tool = {
            use_id: toolCall.call_id,
            event: "use",
            provider: "local",
            type: (toolInfo?.type || "mcp") as "mcp" | "sql" | "http",
            label,
            name: _name,
          };
        } else {
          const toolInfo = this.tools.find((t) => t.name === name);

          tool = {
            use_id: toolCall.call_id,
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
            task: { id: taskId },
            tool: tool!,
            type: "text" as const,
            kind: "text" as const,
            text,
          },
        };
      });

      return { messages };
    }

    // No tool calls — fall back to any plain text output items.
    const text = response.output
      .filter((item): item is OpenAI.Responses.ResponseOutputMessage =>
        item.type === "message"
      )
      .flatMap((item) =>
        item.content
          .filter((c): c is OpenAI.Responses.ResponseOutputText =>
            c.type === "output_text"
          )
          .map((c) => c.text)
      )
      .join("\n")
      .trim();

    // Mesmo corte do protocolo chat-completions, pelo mesmo motivo: com
    // `tool_choice` obrigatório, o único caminho autorizado até o contato é a
    // ferramenta `respond`. Texto que chega por fora dela não é resposta, é
    // defeito — e num caso real o "defeito" era o raciocínio interno do modelo,
    // que foi entregue e lido por um cliente. Fica interno. - 2026/08/04
    //
    // A saída estreita de 2026/08/10 vale aqui igual: texto que passa pelo
    // crivo vai ao cliente, porque silêncio também é um jeito de errar com ele.
    // O porquê inteiro está em `podeIrAoCliente`.
    if (text && MULTI_MESSAGE_RESPONSE && podeIrAoCliente(text)) {
      log.warn("Loose text passed the leak screen and was sent as the reply.");

      return {
        messages: [
          {
            organization_id: conversation.organization_id,
            service: conversation.service,
            organization_address: conversation.organization_address,
            contact_address: conversation.contact_address,
            direction: "outgoing" as const,
            agent_id: agent.id,
            content: {
              version: "1" as const,
              type: "text" as const,
              kind: "text" as const,
              text,
            },
          },
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
                "O modelo escreveu esta resposta em texto solto, sem usar a ferramenta de resposta. O texto foi conferido e enviado ao contato assim mesmo — o contrário seria deixá-lo sem nada.",
            },
          },
        ],
      };
    }

    if (text && MULTI_MESSAGE_RESPONSE) {
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
                `O modelo respondeu em texto solto em vez de usar a ferramenta de resposta, então nada foi enviado ao contato. O que ele produziu:\n\n${text}`,
            },
          },
        ],
        silence: silenceNote(
          "o modelo respondeu em texto solto em vez de chamar `respond`; o texto ficou interno para não ir ao cliente",
          response.usage,
        ),
      };
    }

    if (text) {
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
              text,
            },
          },
        ],
      };
    }

    // Cortado pelo limite, e a segunda tentativa com teto maior também não
    // coube. Dizer isso, e não devolver o silêncio mudo de antes: quem lê a
    // nota precisa saber que o caminho é o `max_tokens` do agente, não o texto
    // das instruções. - 2026/08/05
    if (response.cutShort) {
      return {
        messages: [],
        silence: silenceNote(
          "o modelo estourou o limite de tokens de saída antes de escrever a resposta, e a tentativa com teto maior e menos raciocínio também não coube",
          response.usage,
        ),
      };
    }

    // O último caminho: nem ferramenta, nem texto, nem corte. Devolvia
    // `{ messages: [] }` mudo — silêncio sem rastro, que é exatamente o defeito
    // que o watchdog e a nota foram criados para acabar. O `chat_completions`
    // sempre teve a sua nota final; aqui faltava. - 2026/08/06
    return {
      messages: [],
      silence: silenceNote(
        "o modelo terminou sem chamar `respond`, sem texto e sem corte por limite",
        response.usage,
      ),
    };
  }
}
