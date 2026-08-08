import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import * as log from "../_shared/logger.ts";
import { corsHeaders } from "../_shared/cors.ts";
import {
  type ContactRow,
  createUnsecureClient,
  type DataPart,
  type InternalMessage,
  type LocalMCPToolConfig,
  type MessageInsert,
  type MessageRow,
  type OutgoingMessage,
  type Part,
  type TextPart,
  type ToolInfo,
  type WebhookPayload,
} from "../_shared/supabase.ts";
import { ProtocolFactory } from "./protocols/index.ts";
import { DEFAULT_TIMEZONE, isOpenAt } from "./protocols/context.ts";
import { callTool, initMCP, type MCPServer } from "./tools/mcp.ts";
import { Toolbox } from "./tools/index.ts";
import { transferToHumanAgentImplementation } from "./tools/handoff.ts";
import { z } from "zod";
import Ajv2020 from "ajv";
import type { AgentRowWithExtra, ResponseContext } from "./protocols/base.ts";
import { getFileMetadata } from "../_shared/media.ts";
import { type MessageRowV0, toV1 } from "../_shared/messages-v0.ts";

const sanitizeLabel = (label: string) => {
  return label
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9_-]/g, "_");
};

export type AgentTool = {
  provider: "local";
  type: "function" | "custom" | "mcp" | "http" | "sql";
  label?: string;
  name: string;
  description?: string;
  inputSchema: z.core.JSONSchema.JSONSchema;
  outputSchema?: z.core.JSONSchema.JSONSchema;
  // deno-lint-ignore no-explicit-any
  implementation?: any;
  // deno-lint-ignore no-explicit-any
  config?: any;
};

const PAUSED_CONV_WINDOW = 12 * 60 * 60 * 1000; // 12 hours
/**
 * How long the out-of-hours notice stays quiet after being sent to a
 * conversation.
 *
 * A fixed window rather than "once per closed stretch", which would be the
 * exact rule. Exact means walking the schedule backwards to find the last
 * closing time, for a difference nobody can perceive: twelve hours covers one
 * night, and a customer who writes on Saturday and again on Sunday getting two
 * notices is reasonable, not a bug. - 2026/08/01
 */
const AWAY_MESSAGE_WINDOW = 12 * 60 * 60 * 1000; // 12 hours

/**
 * O erro que vai para a conversa, com o que o provedor de fato disse.
 *
 * A mensagem do SDK sozinha é "422 Provider returned error" — que não diz
 * nada. O motivo real vem dentro do corpo da resposta, e num caso concreto era
 * "no online provider for model gpt-oss-20b advertises inference for
 * tool_choice required": a rota gratuita daquele modelo não aceita o modo de
 * chamada de ferramenta que este backend usa.
 *
 * Sem o detalhe, a conclusão natural é "as ferramentas estão quebradas".
 * Custou uma investigação inteira descobrir que era o modelo escolhido, e
 * quem só tem a tela na frente não teria como chegar lá. - 2026/08/02
 */
function describeError(error: unknown): string {
  const base = error instanceof Error ? error.message : String(error);

  /**
   * O erro do PostgREST vem com código, dica e detalhe — e sem eles a mensagem
   * é uma parede.
   *
   * "Cannot coerce the result to a single JSON object" apareceu numa conversa
   * em 2026/08/07 e não dizia qual consulta, qual tabela, nem se foram zero ou
   * duas linhas. Passei três hipóteses erradas antes de perceber que estava
   * adivinhando de novo. O código (PGRST116) e o `details` respondem as três
   * perguntas de uma vez. - 2026/08/07
   */
  const pg = error as { code?: string; details?: string; hint?: string };

  if (pg?.code || pg?.details) {
    return [
      base,
      pg.code ? `[${pg.code}]` : undefined,
      pg.details,
      pg.hint,
    ].filter(Boolean).join(" ").slice(0, 500);
  }

  // O SDK da OpenAI guarda o corpo do provedor em `error.error`.
  const detail = (error as { error?: { metadata?: { raw?: string } } })?.error
    ?.metadata?.raw;

  if (!detail) return base;

  try {
    const parsed = JSON.parse(detail) as { error?: { message?: string } };
    const message = parsed.error?.message;

    return message ? `${base}: ${message}` : base;
  } catch {
    return `${base}: ${detail}`.slice(0, 500);
  }
}

/**
 * O que conta como "uma pessoa vai te responder".
 *
 * Só as formas que prometem AÇÃO DE TERCEIRO: "confirmo com a equipe", "vou
 * chamar alguém", "já te retorno". Ficam de fora as que o assistente cumpre
 * sozinho — "já verifico a agenda" é promessa dele, e ele cumpre na mesma
 * volta. - 2026/08/07
 */
export const PROMISE_OF_A_PERSON =
  // `\S*` e não `\w+` no fim de "responsável": `\w` não casa acento, e foi
  // exatamente essa palavra que escapou no primeiro teste. - 2026/08/07
  // "estou transferindo" entrou em 2026/08/08: numa sondagem o modelo escreveu
  // "Um momento, estou transferindo sua solicitação para um colega" e o detector
  // não viu promessa nenhuma. Naquela vez ele tinha mesmo chamado a ferramenta,
  // então ninguém ficou esperando — mas a frase mais direta que existe para
  // dizer "vem alguém" passava batida, e no dia em que viesse sem a chamada o
  // aviso não sairia.
  // `(\s+\S+){0,3}` entre o verbo e o "com", e `já retorno` sem o "te", vieram
  // da mesma medição: "Confirmando o valor com a equipe, já retorno pra você."
  // A versão anterior exigia o verbo colado no "com" e o "te" antes de
  // "retorno", e essa frase — promessa das mais claras — passava pelas duas
  // peneiras. Era 1 conversa perdida em 6.
  //
  // O limite de 3 palavras é o que separa "confirmo O VALOR com a equipe" de
  // uma frase que só por acaso tem as duas palavras longe uma da outra.
  /(confirm\w+|verific\w+|falar|checar)(\s+\S+){0,3}\s+com\s+(a\s+|o\s+|um\s+|uma\s+)?(equipe|time|colega|profissional|respons\S*|gerente|dono)|vou\s+(chamar|passar|encaminhar|transferir)|(estou|vou)\s+transferindo|transferindo\s+(voc[êe]|sua|seu|isso|a\s+conversa)|(j[áa]|te)\s+retorno|volto\s+a\s+(falar|te)|assim\s+que\s+(souber|confirmar|a\s+equipe)/i;

const MESSAGES_TIME_LIMIT = 7 * 24 * 60 * 60 * 1000; // 7 days
const MESSAGES_QUANTITY_LIMIT = 50;
const RESPONSE_DELAY_SECS = 3; // 3 seconds
const MEDIA_PREPROCESSING_TIMEOUT = 30 * 1000; // 30 seconds
const MEDIA_PREPROCESSING_POLLING_INTERVAL = 5 * 1000; // 5 seconds

/**
 * timestamp vs created_at
 *
 *  - timestamp is given by the service (i.e. WhatsApp) servers.
 *  - created_at is the insertion timestamp in our database.
 *
 *  The contact might send several messages very close in time. The goal is to react
 *  once for the whole batch. Each message will trigger a function. Only one of them
 *  should go through. The selection criteria is the function corresponding to the
 *  newest message by created_at.
 *
 *  The newest message might not be the one with the latest timestamp. The order of
 *  arrival is not guaranteed. Anyway, messages are ordered by timestamp, hence the
 *  agent will get the conversation history in the correct order.
 */

function getNewestIncomingMessage(
  incoming: MessageRow,
  messages: MessageRow[],
) {
  const incomingCreatedAt = new Date(incoming.created_at);

  const sortedMessages = messages
    .filter((m) => m.direction === "incoming")
    .filter((m) => new Date(m.created_at) >= incomingCreatedAt)
    .sort((a, b) => {
      const dateA = +new Date(a.created_at);
      const dateB = +new Date(b.created_at);

      if (dateA !== dateB) {
        return dateB - dateA; // descending by created_at
      }

      // If created_at is the same, order by id descending
      if (a.id < b.id) return 1;
      if (a.id > b.id) return -1;
      return 0;
    });

  return sortedMessages[0];
}

const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  const authHeader = req.headers.get("Authorization");
  const token = authHeader?.replace("Bearer ", "");

  if (token !== SERVICE_ROLE_KEY) {
    return new Response("Unauthorized", { status: 401 });
  }

  const client = createUnsecureClient();

  const incoming = ((await req.json()) as WebhookPayload<MessageRow>).record!;

  // RETRIEVE CONVERSATION + ORGANIZATION + CONTACT + AGENTS (via organization, one-hop join)

  const { data: conv } = await client
    .from("conversations")
    .select(`
      *,
      organizations (*, agents (*)),
      contacts_addresses (*, contacts (*))
    `)
    .eq("id", incoming.conversation_id)
    .single()
    .throwOnError();

  if (!conv.extra) {
    conv.extra = {};
  }

  const {
    organizations: org,
    contacts_addresses: contact_address,
    ...conversation
  } = conv;

  log.info("Agent client context", {
    conversation_id: conv.id,
    has_org: !!org,
    has_contact_address: !!contact_address,
  });

  const organization_id = org.id;

  if (!org.extra) {
    org.extra = {};
  }

  const { agents, ...organization } = org;

  let contact: ContactRow | undefined;

  if (contact_address) {
    contact = contact_address.contacts || undefined;

    if (!contact_address.extra) {
      contact_address.extra = {};
    }

    if (!contact && contact_address.extra.name) {
      contact = {
        name: contact_address.extra.name,
      } as ContactRow;
    }
  }

  if (contact) {
    if (!contact.extra) {
      contact.extra = {};
    }
  }

  // CHECK IF CONTACT IS ALLOWED

  /**
   * Default behavior: Respond to all contacts.
   *
   * When org.extra.authorized_contacts_only is true, only respond to allowed contacts.
   *
   * An allowed contact has the contact.extra.allowed field set to true.
   */

  if (
    conv.service !== "local" &&
    org.extra.authorized_contacts_only
    // TODO: && !contact?.extra?.allowed
  ) {
    log.info(
      `Conversation ${conv.id} does not correspond to an authorized contact. Skipping response.`,
    );

    return new Response("ok", { headers: corsHeaders });
  }

  // CHECK IF THE CONTACT IS BLOCKED

  /*
   * Blocking lives on the contact address, not on the conversation:
   * `conversations` has no unique constraint tying one row to one contact, so a
   * flag stored there would not survive a second thread from the same number.
   *
   * Messages keep arriving and keep being stored — the CRM hides them, it does
   * not refuse them. The WhatsApp Cloud API gives a business no way to stop
   * someone from writing, and dropping them on the way in would leave no record
   * if the person later claims they made contact. What blocking buys is
   * silence: the agent stops answering in your name inside a conversation you
   * can no longer see. - 2026/07/31
   */
  if (contact_address?.status === "blocked") {
    log.info(
      `Contact ${contact_address.address} is blocked. Skipping response.`,
    );

    return new Response("ok", { headers: corsHeaders });
  }

  // CHECK IF CONVERSATION IS PAUSED

  if (
    conv.extra.paused &&
    +new Date(conv.extra.paused) > +new Date() - PAUSED_CONV_WINDOW
  ) {
    log.info(`Conversation ${conv.id} is paused. Skipping response.`);

    return new Response("ok", { headers: corsHeaders });
  }

  // WAIT FOR A NEWER MESSAGE

  const delay = (org.extra.response_delay_seconds ?? RESPONSE_DELAY_SECS) *
    1000;

  if (delay > 0) {
    log.info(`Waiting ${delay}ms before processing the message...`);

    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  // RETRIEVE MESSAGES

  const { data: messagesMixedVersions } = await client
    .from("messages")
    .select()
    .eq("conversation_id", incoming.conversation_id)
    .gt("timestamp", new Date(+new Date() - MESSAGES_TIME_LIMIT).toISOString()) // Time constraint for the conversation.
    .lte("timestamp", new Date().toISOString()) // Scheduled messages have a future timestamp.
    .order("timestamp", { ascending: false })
    .limit(MESSAGES_QUANTITY_LIMIT) // Size constraint for the conversation.
    .throwOnError();

  const messages = messagesMixedVersions
    .map((m) =>
      m.content.version === "1" ? m : toV1(m as unknown as MessageRowV0)
    )
    .filter(Boolean) as MessageRow[];

  // Query was done in descending order to apply the limit.
  // We need the messages in chronological order, though.
  messages.reverse();

  // CHECK IF THERE IS A NEWER MESSAGE
  const newestMessage = getNewestIncomingMessage(incoming, messages);

  if (newestMessage.id !== incoming.id) {
    // Then the newest message is not the incoming one that triggered this edge function.
    log.info(
      `Newer message ${newestMessage.id} found for conversation ${conv.id}. Skipping response.`,
    );

    return new Response("ok", { headers: corsHeaders });
  }

  // SESSION RESTART if /new is found — USEFUL FOR WHATSAPP TESTING

  const firstMessageIndex = messages.findLastIndex(
    ({ direction, content }) =>
      direction === "incoming" &&
      content.type === "text" &&
      content.text.startsWith("/new"),
  );

  if (firstMessageIndex > -1) {
    const firstMessage = messages[firstMessageIndex].content as TextPart;

    firstMessage.text = firstMessage.text.replace("/new", "");

    messages.splice(0, firstMessageIndex);

    // Also, reset the conversation memory
    if (conv.extra.memory && Object.keys(conv.extra.memory).length) {
      conv.extra.memory = {};

      await client
        .from("conversations")
        .update({ extra: conv.extra })
        .eq("id", incoming.conversation_id)
        .throwOnError();
    }
  }

  log.info("Contact request", messages.at(-1)?.content);

  // WELCOME MESSAGE
  // Note: The welcome message is affected by allowed contacts. This behavior
  // differs from WhatsApp, which sends the welcome message to all contacts.

  /**
   * A boas-vindas precede a resposta; não a substitui.
   *
   * Aqui havia um `return`: a primeira mensagem de toda conversa recebia o
   * cumprimento genérico e mais nada. Medido numa conversa de verdade — "oi,
   * quero marcar um corte quinta de manhã" respondido com "Conte em que podemos
   * ajudar", e silêncio. Quem escreve uma pergunta concreta e recebe um cartaz
   * conclui que não tem ninguém do outro lado, e é a primeira impressão de todo
   * cliente novo.
   *
   * A mensagem é gravada com `select` e entra no contexto antes de o assistente
   * ser chamado. Sem isso ele cumprimentaria de novo, porque não saberia que a
   * saudação já foi dada — o custo de mandar duas seria trocar um defeito por
   * outro. - 2026/08/06
   */
  if (
    org.extra.welcome_message &&
    messages.every((m) => m.direction !== "outgoing")
  ) {
    const outgoing: MessageInsert = {
      organization_id: conv.organization_id,
      conversation_id: conv.id,
      service: conv.service,
      organization_address: conv.organization_address,
      contact_address: conv.contact_address,
      direction: "outgoing",
      content: {
        version: "1",
        type: "text",
        kind: "text",
        text: org.extra.welcome_message,
      },
    };

    log.info("Welcome message", (outgoing.content as TextPart).text);

    const { data: welcome } = await client
      .from("messages")
      .insert(outgoing)
      .select()
      .single()
      .throwOnError();

    // A linha volta do banco com o `direction` fixado em "outgoing", que o
    // TypeScript não reconcilia com a união de `MessageRow` — mesma forma,
    // declarações diferentes.
    messages.push(welcome as unknown as typeof messages[number]);
  }

  // OUT OF HOURS
  //
  // The WhatsApp Business app sends an away message natively; the Cloud API
  // does not, so it happens here — built the same way as the welcome message
  // above, which is the same act with a different condition.
  //
  // Whether the agent then answers is the organization's call, and the two
  // answers are different products: a shop that wants the bot selling at 3am
  // needs it to keep going, one that wants the WhatsApp behaviour does not.
  // - 2026/08/01

  if (org.extra.business_hours?.length) {
    const timezone = org.extra.timezone || DEFAULT_TIMEZONE;
    const closed = !isOpenAt(org.extra.business_hours, timezone);

    if (closed) {
      const sentRecently = conv.extra.away_sent &&
        +new Date(conv.extra.away_sent) > +new Date() - AWAY_MESSAGE_WINDOW;

      if (org.extra.away_message && !sentRecently) {
        const outgoing: MessageInsert = {
          organization_id: conv.organization_id,
          conversation_id: conv.id,
          service: conv.service,
          organization_address: conv.organization_address,
          contact_address: conv.contact_address,
          direction: "outgoing",
          content: {
            version: "1",
            type: "text",
            kind: "text",
            text: org.extra.away_message,
          },
        };

        log.info("Away message", (outgoing.content as TextPart).text);

        // No contexto também, pelo mesmo motivo da boas-vindas: quando o
        // assistente segue respondendo — que é a configuração padrão — ele
        // precisa saber que o aviso de fechado já foi dado, senão repete.
        // - 2026/08/06
        const { data: away } = await client
          .from("messages")
          .insert(outgoing)
          .select()
          .single()
          .throwOnError();

        messages.push(away as unknown as typeof messages[number]);

        // Stamped whether or not the agent goes on to reply, since the point
        // is not to repeat the notice. The `set_extra` trigger merges, so this
        // touches one key.
        await client
          .from("conversations")
          .update({ extra: { away_sent: new Date().toISOString() } })
          .eq("id", conv.id)
          .throwOnError();
      }

      if (org.extra.pause_agent_when_closed) {
        log.info(`Conversation ${conv.id} is out of hours. Skipping response.`);

        return new Response("ok", { headers: corsHeaders });
      }
    }
  }

  // CHECK IF THERE ARE AI AGENTS

  const aiAgents = agents.filter(
    (agent) => agent.ai,
  ) as AgentRowWithExtra[];

  if (!aiAgents.length) {
    log.info(
      `No AI agents found for conversation ${conv.id}. Skipping response.`,
    );
    return new Response("ok", { headers: corsHeaders });
  }

  // AGENT SELECTION

  let agent: AgentRowWithExtra | null | undefined;

  /* Not featuring multiple agents per conversation by the time being.

  // 1. Find the agent_id of the last message from an AI agent

  const lastAgentId = messages.findLast((m) => m.agent_id)?.agent_id;

  agent = aiAgents.find((a) => a.id === lastAgentId);

  // 2. Fallback to the contact's group default agent

  const groupAgentMap = org.extra.default_agent_id_by_contact_group;

  if (!agent && groupAgentMap) {
    const defaultAgentId =
      groupAgentMap[conv.contacts?.extra?.group || "undefined"];

    agent = aiAgents.find((a) => a.id === defaultAgentId);
  }
  */

  // 4. Use the agent defined in the conversation
  // For internal conversations, the agent does need to be active.

  agent = aiAgents.find((a) =>
    (conv.service === "local" || a.extra?.mode !== "inactive") &&
    a.id === conversation.extra?.default_agent_id
  );

  // 3. Fallback to the oldest active agent

  if (!agent) {
    agent = aiAgents.filter((a) => a.extra?.mode !== "inactive").sort((a, b) =>
      +a.created_at - +b.created_at
    ).at(0);
  }

  if (!agent) {
    log.info(
      `No active AI agents found for conversation ${conv.id}. Skipping response.`,
    );
    return new Response("ok", { headers: corsHeaders });
  }

  //---------------------------------------------------------------------------
  // Up to this point all checks passed. We can proceed with the response.
  //---------------------------------------------------------------------------

  // TYPING INDICATOR

  const indicateTyping = async (unread?: boolean) => {
    const { error: typingIndicatorError } = await client
      .from("messages")
      .update({
        status: {
          ...(unread && { read: new Date().toISOString() }),
          typing: new Date().toISOString(),
        },
      })
      .eq("id", incoming.id);

    if (typingIndicatorError) {
      log.warn(
        "Failed to update incoming message typing indicator status.",
        typingIndicatorError,
      );
    }
  };

  indicateTyping(true);

  // The typing indicator will be dismissed once an agent respond,
  // or after 25 seconds. Hence, keep it alive. Some extra delay
  // is added to avoid race conditions with the response.
  const typingInterval = setInterval(indicateTyping, 30000);

  // CONTEXT

  if (!agent.extra) {
    agent.extra = {};
  }

  /**
   * O que este contato já tem marcado.
   *
   * Simulado em 2026/08/07: "preciso cancelar meu horário" fez o assistente
   * pedir o dia e a hora duas vezes, porque `list_appointments` mostra a agenda
   * da casa por data e não os compromissos de uma pessoa. Quem não lembra a
   * data não consegue cancelar — e liga, que é justamente o que este sistema
   * existe para evitar.
   *
   * Buscado aqui, e não numa ferramenta nova: é fato do contexto, como o nome
   * do cliente. Uma ferramenta seria uma ida ao modelo a mais para descobrir
   * algo que já se sabe. - 2026/08/07
   */
  let appointments;

  if (conv.contact_address) {
    const { data: rows } = await client
      .from("appointments")
      .select("title, starts_at, duration_minutes")
      .eq("organization_id", organization_id)
      .eq("contact_address", conv.contact_address)
      .eq("status", "scheduled")
      .gte("starts_at", new Date().toISOString())
      .order("starts_at", { ascending: true })
      .limit(5);

    const timezone = org.extra.timezone || DEFAULT_TIMEZONE;

    appointments = rows?.map((row) => ({
      title: row.title,
      // Hora local da casa, como em toda parte: o modelo nunca converte fuso.
      starts_at: new Date(row.starts_at).toLocaleString("sv-SE", {
        timeZone: timezone,
      }).slice(0, 16),
      weekday: new Date(row.starts_at).toLocaleDateString("en-US", {
        timeZone: timezone,
        weekday: "long",
      }).toLowerCase(),
      duration_minutes: row.duration_minutes,
    }));
  }

  const context = {
    organization,
    conversation,
    messages,
    contact,
    agent: agent as AgentRowWithExtra,
    appointments,
  };

  if (agent.extra.tools) {
    for (const tool of agent.extra.tools) {
      if ("label" in tool) {
        tool.label = sanitizeLabel(tool.label);
      }
    }
  }

  // REQUEST LOOP

  /**
   * agent.extra.tools
   *   - function
   *   - mcp
   *   - gemini: google_search, code_execution, url_context
   *   - openai: mcp, web_search_preview, file_search, image_generation, code_interpreter, computer_use_preview
   *   - anthropic: mcp*, bash, code_execution, computer, str_replace_based_edit_tool, web_search
   *
   * context.tools -> tools + expanded mcp tools
   */

  const mcpServers: Map<string, MCPServer> = new Map();

  let iteration = 0;
  const max_iterations = 10;
  let shouldContinue = true;

  /**
   * Quanto tempo o laço pode gastar antes de desistir por conta própria.
   *
   * Havia teto de rodadas e não havia teto de relógio, e o que estoura primeiro
   * é o relógio: a plataforma mata a função no meio da chamada seguinte, e o
   * `catch` abaixo — que existe justamente para deixar rastro — nunca roda. O
   * resultado é o pior que um atendimento pode ter: o cliente escreveu, o
   * assistente calou, e não há uma linha em lugar nenhum dizendo por quê.
   *
   * Aconteceu com um "Bom dia!": o modelo levou 95 segundos para a primeira
   * chamada, a segunda não coube, e a conversa terminou no resultado de uma
   * ferramenta. Sem erro, sem resposta, sem nada.
   *
   * O número é folgado de propósito. Ele não corta chamada nenhuma pela metade
   * — só recusa começar mais uma quando o que sobra não dá para terminá-la e
   * ainda gravar o aviso. - 2026/08/04
   */
  const TIME_BUDGET_MS = 100_000;
  const startedAt = Date.now();

  // Marcado onde as mensagens são gravadas, e não conferido depois pelo
  // `created_at`: o relógio do banco e o desta função não são o mesmo, e alguns
  // segundos de diferença fariam a tela acusar mudez numa conversa respondida.
  let answeredContact = false;

  // O último motivo declarado pelo protocolo para não ter havido mensagem.
  let silence: string | undefined;

  /**
   * Quantas mensagens a última rodada produziu.
   *
   * É o que sobra para dizer quando ninguém declarou motivo. Aconteceu de
   * verdade: a nota chegou à conversa dizendo "não produziu resposta" e mais
   * nada, três vezes seguidas, e nem o protocolo nem o laço tinham o que
   * acrescentar — a investigação começou e terminou no escuro.
   *
   * Não substitui o motivo de quem sabe; é o piso. Uma nota sem número
   * nenhum não deve ser possível de escrever. - 2026/08/06
   */
  let lastRoundMessages = 0;

  /**
   * A promessa de que uma pessoa vai voltar — e se alguém foi de fato chamado.
   *
   * Simulado em 2026/08/07: "quanto custa o corte?" recebeu "o valor eu
   * confirmo com a equipe e já te retorno", sem nenhuma ferramenta. Ninguém foi
   * avisado, a conversa não foi marcada, e o cliente ficou esperando um retorno
   * que não existia. É o mesmo defeito do handoff, agora vestido de preço.
   *
   * Melhorar a descrição da ferramenta já foi tentado e melhorou pela metade.
   * Isto não tenta convencer o modelo: quando a promessa sai sem transferência,
   * a equipe recebe uma nota. Não conserta a conversa — torna visível a que
   * precisa de gente, que é a diferença entre um cliente atendido com atraso e
   * um cliente perdido em silêncio.
   *
   * Casar texto é frágil, e o preço do erro é conhecido nos dois sentidos: um
   * falso positivo é uma nota a mais para quem atende, um falso negativo é o
   * que já acontece hoje. Nenhum dos dois manda mensagem errada ao cliente.
   * - 2026/08/07
   */
  let step = "antes do laço";
  let handedOff = false;
  let promised = false;

  // Basic ReAct algorithm: stop if no tool uses are found.
  while (shouldContinue) {
    iteration++;

    let response: ResponseContext = {};

    try {
      if (iteration > max_iterations) {
        throw new Error("Max LLM iterations reached!");
      }

      // Só a partir da segunda rodada: a primeira tem de acontecer, por mais
      // lento que o modelo seja. Desistir antes de tentar seria calar sozinho.
      if (iteration > 1 && Date.now() - startedAt > TIME_BUDGET_MS) {
        throw new Error(
          `The model took too long to answer: ${
            Math.round((Date.now() - startedAt) / 1000)
          }s over ${
            iteration - 1
          } call(s), and there was not enough time left ` +
            `to finish this conversation. Nothing was sent to the contact. ` +
            `A faster model fixes this.`,
        );
      }

      // CHECK FOR PENDING PREPROCESSING

      while (org.extra.media_preprocessing?.mode === "active") {
        const pendingPreprocessing = messages.filter(
          (m) =>
            m.content.type === "file" &&
            m.status.pending && // Note: not using status.preprocessing to avoid race conditions with the media preprocessor Edge Function.
            !m.status.preprocessed &&
            +new Date(m.status.pending) >
              +new Date() - MEDIA_PREPROCESSING_TIMEOUT,
        );

        if (!pendingPreprocessing.length) {
          break;
        }

        // WAIT FOR THE PREPROCESSING TO COMPLETE

        log.info(
          `Waiting ${MEDIA_PREPROCESSING_POLLING_INTERVAL}ms for pending preprocessing to complete...`,
        );

        await new Promise((resolve) =>
          setTimeout(resolve, MEDIA_PREPROCESSING_POLLING_INTERVAL)
        );

        // Note: we could check for newer messages here too, but it would bloat the code.

        // RETRIEVE PROCESSED MESSAGES

        const { data: pending_messages } = await client
          .from("messages")
          .select()
          .in(
            "id",
            pendingPreprocessing.map((m) => m.id),
          )
          .throwOnError();

        // Update the messages with the pending processing.
        for (const pm of pending_messages) {
          const index = messages.findIndex((m) => m.id === pm.id);

          if (index > -1) {
            messages[index] = pm;
          }
        }
      }

      // CHECK IF THERE IS A NEWER INCOMING MESSAGE (posterior to the incoming one)

      const { data: new_message } = await client
        .from("messages")
        .select()
        .eq("conversation_id", incoming.conversation_id)
        .eq("direction", "incoming")
        .gt("created_at", incoming.created_at)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle()
        .throwOnError();

      if (new_message) {
        log.info(
          `Newer message ${new_message.id} for conversation ${conv.id} found while processing tool use messages and/or waiting for pending preprocessing. Skipping response.`,
        );

        return new Response("ok", { headers: corsHeaders });
      }

      // MCP SERVERS INITIALIZATION
      // It is here because of multi-agents, which we are not using by the time being.

      const mcpServersToInit = agent.extra.tools?.filter(
        (tool) =>
          tool.provider === "local" &&
          tool.type === "mcp" &&
          !mcpServers.has(tool.label),
      ) || [];

      const mcpServersAux = await Promise.all(
        mcpServersToInit.map((tool) =>
          initMCP(tool as LocalMCPToolConfig, context)
        ),
      );

      mcpServersAux.forEach((mcp) => {
        mcpServers.set(mcp.label, mcp);
      });

      // CURRENT ITERATION TOOLS

      /**
       * Tools to be passed the agent are gruped in two main categories:
       * 1. Local tools
       * 2. External tools
       *
       * Local tools need to be passed to the agent with their input schema.
       * External tools do not require more than their tool config as it comes.
       *
       * We have the following tool types:
       * - `ToolInfo` to tag tool use/result messages with basic tool info (specially `label` and `name`).
       * - `ToolConfig` for agents to declare their tools (`label`, `name` might be unknown for MCP tools and others).
       * - `ToolDefinition`, which as its name suggests, defines the tool (`label` is unknown at definition, only `name`).
       * - `AgentTool`, the combination of config and definition, to be passed to the agent.
       */
      const tools: AgentTool[] = [];

      for (const toolConfig of agent.extra.tools || []) {
        if (toolConfig.provider !== "local") {
          continue;
        }

        switch (toolConfig.type) {
          case "function": {
            const unlabeledTool = Toolbox.function.find(
              (t) => t.name === toolConfig.name,
            );

            if (!unlabeledTool) {
              throw new Error(`Tool ${toolConfig.name} not found.`);
            }

            tools.push(unlabeledTool);

            break;
          }
          case "mcp": {
            const unlabeledTools = mcpServers.get(toolConfig.label)!.tools;

            for (const unlabeledTool of unlabeledTools) {
              const labeledTool = {
                provider: toolConfig.provider,
                type: toolConfig.type,
                label: toolConfig.label,
                name: unlabeledTool.name,
                description: unlabeledTool.description,
                inputSchema: unlabeledTool
                  .inputSchema as z.core.JSONSchema.JSONSchema,
                outputSchema: unlabeledTool.outputSchema as
                  | z.core.JSONSchema.JSONSchema
                  | undefined,
                config: toolConfig.config,
              };

              tools.push(labeledTool);
            }

            break;
          }
          case "http":
          case "sql": {
            const unlabeledTools = Toolbox[toolConfig.type];

            for (const unlabeledTool of unlabeledTools) {
              const labeledTool = {
                ...unlabeledTool,
                label: toolConfig.label,
                config: toolConfig.config,
              };

              tools.push(labeledTool);
            }

            break;
          }
        }
      }

      // AGENT CLIENT REQUEST AND RESPONSE

      const handler = ProtocolFactory.getHandler(tools, context, client);

      /**
       * Em que etapa o laço estava quando quebrou.
       *
       * Uma falha em cada seis chega como "Cannot coerce the result to a single
       * JSON object [PGRST116] 0 linhas" — o detalhe diz o QUE, e continua sem
       * dizer ONDE. Três hipóteses erradas depois, a lição é a mesma do resto
       * deste arquivo: instrumentar em vez de adivinhar.
       *
       * Três etapas bastam para separar montar o pedido, falar com o modelo e
       * ler a resposta — e cada uma tem um punhado de consultas, não trinta.
       * - 2026/08/07
       */
      step = "montando o pedido";
      const agentRequest = await handler.prepareRequest();

      step = "chamando o modelo";
      const agentResponse = await handler.sendRequest(agentRequest);

      step = "lendo a resposta";
      response = await handler.processResponse(agentResponse);

      step = "executando ferramentas";

      // Guardado para o aviso do fim: quando ninguém responder, o motivo é o
      // da última rodada, que é a que decidiu calar.
      if (response.silence) silence = response.silence;

      if (!response.messages?.length) {
        response.messages = [];
      }

      // TOOL USES AND RESULTS

      const toolUses = response.messages.filter(
        (m) =>
          m.direction === "internal" &&
          m.content.type === "text" &&
          m.content.tool &&
          m.content.tool.provider === "local",
      ) || [];

      if (
        toolUses.some((m) =>
          m.direction === "internal" && m.content.type === "text" &&
          // Nem toda ferramenta tem nome: as do Google entram por tipo.
          (m.content.tool as { name?: string } | undefined)?.name ===
            "transfer_to_human_agent"
        )
      ) {
        handedOff = true;
      }

      promised ||= response.messages.some((m) =>
        m.direction === "outgoing" && m.content.type === "text" &&
        PROMISE_OF_A_PERSON.test(m.content.text ?? "")
      );

      for (const row of toolUses) {
        // Only needed to please the TypeScript compiler
        if (
          row.direction !== "internal" ||
          row.content.type !== "text" ||
          !row.content.tool ||
          row.content.tool.provider !== "local"
        ) {
          continue;
        }

        /**
         * # Tool uses and results within parallel tool use
         *
         * Chat Completions API produces a single message with several tool choices.
         * It expects tool results as single messages.
         *
         * On the other hand, Responses API and Messages API also produce a single with several tool uses.
         * But on the contrary, they expect tool results as a single message.
         *
         * Here, the adopted policy is to adhere to the WhatsApp API, this is one message per part.
         * A tool use/result is considered a part.
         */

        let parts: (Part & ToolInfo)[] = [];

        const toolInfo = row.content.tool;

        const agentTool = tools.find(
          (t) =>
            t.provider === toolInfo.provider &&
            t.type === toolInfo.type &&
            ("label" in toolInfo ? t.label === toolInfo.label : true) &&
            t.name === toolInfo.name,
        );

        try {
          if (!agentTool) {
            throw new Error(
              `Tool ${toolInfo.name} not found between available tools.`,
            );
          }

          const ajv = new Ajv2020();
          // Strip $schema since MCP SDK (via Zod) produces draft-07 schemas,
          // but Ajv is imported as the 2020-12 build and rejects unknown drafts.
          // deno-lint-ignore no-explicit-any
          const { $schema: _, ...schema } = agentTool.inputSchema as any;

          const args = JSON.parse(row.content.text);

          // When JSON parsing is done, the message is converted to a data part.
          row.content = {
            version: "1",
            task: row.content.task,
            tool: toolInfo,
            type: "data",
            kind: "data",
            data: args,
          };

          const valid = ajv.validate(schema, args);

          if (!valid) {
            throw new Error(
              `Tool input validation failed: ${JSON.stringify(ajv.errors)}`,
            );
          }

          switch (toolInfo.type) {
            case "custom":
            case "function": {
              // Same four arguments the http/sql branch below passes. Built-in
              // tools used to get the input alone, which meant one could only
              // compute — never touch the conversation it was called from.
              // `transfer_to_human_agent` is the first that needs to.
              // - 2026/08/01
              const result = await agentTool.implementation(
                args,
                undefined,
                context,
                client,
              );

              parts = [
                {
                  tool: {
                    ...toolInfo,
                    event: "result" as const,
                  },
                  type: "data",
                  kind: "data",
                  data: result,
                },
              ];

              break;
            }
            case "mcp": {
              const mcp = mcpServers.get(agentTool.label!);

              if (!mcp) {
                throw new Error(`MCP server ${agentTool.label} not found.`);
              }

              parts = await callTool(mcp, row.content, context, client);

              break;
            }
            case "http":
            case "sql": {
              const result = await agentTool.implementation(
                args,
                agentTool.config,
                context,
                client,
              );

              const part: DataPart & ToolInfo = {
                tool: {
                  ...toolInfo,
                  event: "result" as const,
                },
                type: "data",
                kind: "data",
                data: result,
              };

              parts = [part];

              if (result.file_uri) {
                part.artifacts = [
                  {
                    type: "file",
                    kind: "document",
                    file: await getFileMetadata(client, result.file_uri),
                  },
                ];
              }

              break;
            }
          }
        } catch (error) {
          const errorMessage = (error as Error).message || String(error);

          log.warn("Tool error", { tool: toolInfo, error });

          parts = [
            {
              tool: {
                ...toolInfo,
                is_error: true,
                event: "result" as const,
              },
              type: "text",
              kind: "text",
              text: errorMessage,
            },
          ];
        }

        // TODO: Mutating the response object is not the most recommended way to do this
        // but it will be improved soon.
        const taskId = row.content.task?.id || crypto.randomUUID();

        for (const part of parts) {
          const message = part.type === "file"
            ? {
              organization_id,
              service: conv.service,
              organization_address: conv.organization_address,
              contact_address: conv.contact_address,
              direction: "outgoing" as const,
              agent_id: agent.id,
              content: {
                version: "1" as const,
                task: { id: taskId },
                ...part,
              } as OutgoingMessage,
            }
            : {
              organization_id,
              service: conv.service,
              organization_address: conv.organization_address,
              contact_address: conv.contact_address,
              direction: "internal" as const,
              agent_id: agent.id,
              content: {
                version: "1" as const,
                task: { id: taskId },
                ...part,
              } as InternalMessage,
            };

          response.messages.push(message);
        }
      }

      if (!toolUses.length) {
        shouldContinue = false;
      }
    } catch (error) {
      shouldContinue = false;

      log.error("Error in agent client", error as Error);

      response.messages = [
        {
          organization_id,
          service: conv.service,
          organization_address: conv.organization_address,
          contact_address: conv.contact_address,
          direction: org.extra.error_messages_direction || "internal",
          agent_id: agent.id,
          content: {
            version: "1" as const,
            type: "text",
            kind: "text",
            text: describeError(error) + ` (etapa: ${step})`,
          },
        },
      ];
    }

    // STORE CURRENT ITERATION MESSAGES

    if (response.messages?.length) {
      log.info("Agent response", response.messages.at(-1)?.content);

      const output_messages = response.messages.map((message, index) => ({
        ...message,
        // Make sure the messages have the correct organization_address and contact_address
        organization_id: conv.organization_id,
        conversation_id: conv.id,
        organization_address: conv.organization_address,
        contact_address: conv.contact_address,
        // Disambiguate by milliseconds index to ensure the insertion order.
        timestamp: new Date(Date.now() + index).toISOString(),
      }));

      try {
        // Insert and select the inserted messages
        const { data: inserted_messages } = await client
          .from("messages")
          .insert(output_messages)
          .select()
          .order("timestamp")
          .throwOnError();

        if (inserted_messages.some((m) => m.direction === "outgoing")) {
          answeredContact = true;
        }

        // Append generated messages to the context
        messages.push(...inserted_messages);
      } catch (storageError) {
        log.error("Failed to store agent response", storageError as Error);

        // Com motivo, e não só no log do servidor: era o único caminho que
        // emudecia sem deixar rastro na conversa. O assistente tinha o que
        // dizer e a gravação é que falhou — quem lê a nota precisa saber que o
        // problema não é a instrução nem o modelo. - 2026/08/06
        silence = `falha ao gravar a resposta do assistente: ${
          describeError(storageError)
        }`;

        shouldContinue = false;
      }
    }

    // Quantas mensagens a rodada produziu, para o caso de nenhuma delas ter
    // sido para o contato e ninguém ter dito por quê.
    lastRoundMessages = response.messages?.length ?? 0;
  }

  // TODO: take care of the typing interval corner cases
  clearInterval(typingInterval);

  /**
   * Se o laço acabou sem uma palavra para o contato, diga isso na conversa.
   *
   * O laço termina quando não há mais chamada de ferramenta, e nada garante que
   * tenha sobrado uma mensagem para a pessoa: o modelo pode devolver um `stop`
   * sem texto, ou uma rodada inteira de ferramenta e mais nada. Nesses casos o
   * assistente simplesmente emudecia — e emudecer não aparece em lugar nenhum,
   * nem numa lista de erros, nem na tela. Quem atende só descobre pela
   * reclamação do cliente, dias depois.
   *
   * Fica interna, como as mensagens de erro: quem tem de saber é a equipe. Ao
   * contato não se manda um pedido de desculpas automático — se o assistente
   * não tem o que dizer, quem diz é uma pessoa. - 2026/08/04
   */
  /**
   * Prometeu que uma pessoa volta, e não chamou ninguém — então o sistema chama.
   *
   * Medido em 2026/08/08, seis tentativas com a instrução dizendo literalmente
   * "confirma com a equipe e passa a conversa": o modelo escreveu a promessa
   * seis vezes e transferiu uma. Ele obedece a primeira metade da frase e larga
   * a segunda. A descrição da ferramenta já diz em maiúsculas que dizer não
   * chama ninguém, e já foi reescrita duas vezes por causa disto; a segunda
   * reescrita levou de 1/3 para metade e parou aí. Continuar polindo texto é
   * apostar de novo no mesmo cavalo.
   *
   * Então a promessa passa a ser verdade por construção: quem disse que alguém
   * retorna, transferiu. A nota interna continua, e agora conta o que o sistema
   * fez — quem cuida do assistente precisa saber que ele ainda erra isso, senão
   * o conserto esconde o defeito.
   *
   * O risco é o inverso: uma frase que o `PROMISE_OF_A_PERSON` reconheça sem ser
   * promessa transfere sem precisar. Custa uma conversa pausada que alguém
   * despausa, visível na lista com a tarja de espera. O erro de hoje custa um
   * cliente esperando para sempre por alguém que nunca foi avisado. - 2026/08/08
   */
  if (promised && !handedOff) {
    log.warn("Agent promised a person without transferring", {
      conversation_id: conv.id,
    });

    let transferida = false;

    try {
      await transferToHumanAgentImplementation(
        {
          reason:
            "O assistente disse ao contato que alguém da equipe retorna. A transferência foi feita pelo sistema, porque ele não a chamou.",
          // Não é reclamação: quem falhou foi o assistente, não a empresa.
          kind: "cannot_resolve" as const,
        },
        undefined,
        { conversation: conv, agent },
        client,
      );

      transferida = true;
    } catch (error) {
      // Falhar aqui não pode derrubar a resposta que já foi ao contato: a nota
      // abaixo passa a ser o único aviso, e é ela que a equipe lê.
      log.error("System handoff after a promise failed", {
        conversation_id: conv.id,
        error: describeError(error),
      });
    }

    await client.from("messages").insert({
      organization_id,
      conversation_id: conv.id,
      service: conv.service,
      organization_address: conv.organization_address,
      contact_address: conv.contact_address,
      direction: "internal" as const,
      agent_id: agent.id,
      content: {
        version: "1" as const,
        type: "text" as const,
        kind: "text" as const,
        text: transferida
          ? "O assistente disse ao contato que alguém da equipe retorna e não transferiu a conversa. O sistema transferiu por ele: esta conversa está esperando uma pessoa."
          : "O assistente disse ao contato que alguém da equipe retorna, mas não transferiu a conversa, e a transferência automática também falhou. Ninguém foi chamado: esta conversa precisa de uma pessoa.",
      },
    });
  }

  if (!answeredContact) {
    log.warn("Agent produced no answer for the contact", { reason: silence });

    /**
     * Ficar sem resposta é ficar esperando uma pessoa — então chama uma.
     *
     * A nota interna sozinha não bastava: ela mora dentro da conversa, e quem
     * atende só a lê se já tiver aberto justamente aquela. Na lista, a conversa
     * emudecida ficava igual a todas as outras — sem tarja, sem cronômetro,
     * fora do filtro de quem espera. O aviso existia e não chamava ninguém, que
     * é a mesma falha da promessa sem transferência, no outro caminho.
     *
     * Medido em 2026/08/08: 1 cliente em 30 cai aqui. Sem isto, esse cliente
     * manda mensagem, não recebe nada, e ninguém é avisado a tempo.
     *
     * Ao contato não se manda pedido de desculpas automático — se o assistente
     * não tem o que dizer, quem diz é uma pessoa. O que muda é que agora essa
     * pessoa fica sabendo. - 2026/08/08
     */
    let chamouAlguem = false;

    try {
      await transferToHumanAgentImplementation(
        {
          reason:
            "O assistente não conseguiu responder a esta mensagem e o sistema chamou uma pessoa. O contato está sem resposta.",
          kind: "cannot_resolve" as const,
        },
        undefined,
        { conversation: conv, agent },
        client,
      );

      chamouAlguem = true;
    } catch (error) {
      log.error("System handoff after a silence failed", {
        conversation_id: conv.id,
        error: describeError(error),
      });
    }

    await client.from("messages").insert({
      organization_id,
      conversation_id: conv.id,
      service: conv.service,
      organization_address: conv.organization_address,
      contact_address: conv.contact_address,
      direction: "internal" as const,
      agent_id: agent.id,
      content: {
        version: "1" as const,
        type: "text" as const,
        kind: "text" as const,
        text: [
          "O assistente não produziu resposta para esta mensagem. Nada foi enviado ao contato.",
          chamouAlguem
            ? "O sistema transferiu a conversa: ela está esperando uma pessoa."
            : "A transferência automática também falhou — ninguém foi chamado.",
          // Sempre um motivo. Quando ninguém declarou um, diga ao menos a forma
          // da última rodada: é a diferença entre uma pista e uma parede.
          `Motivo: ${
            silence ??
              `o laço terminou em ${iteration} rodada(s) e a última produziu ${lastRoundMessages} mensagem(ns), nenhuma para o contato`
          }.`,
        ].join(" "),
      },
    });
  }

  // STORE RESPONSE

  /*
  if (response?.conversation) {
    const { error } = await client
      .from("conversations")
      .update({
        extra: response.conversation.extra,
      })
      .eq("id", incoming.conversation_id)

    if (error) {
      log.error("Failed to update conversation extra field.", error);
    }
  }

  if (contact && response?.contact) {
    const { error } = await client
      .from("contacts")
      .update({
        extra: response.contact.extra,
      })
      .eq("id", contact.id);

    if (error) {
      log.error("Failed to update contact extra field.", error);
    }
  }
  */

  return new Response(JSON.stringify(messages), {
    headers: { "Content-Type": "application/json" },
  });
});
