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
import {
  passosComHora,
  sequenciaPara,
} from "../_shared/sequencia_por_palavra.ts";
import {
  mensagensDaCobranca,
  servicoPara,
} from "../_shared/cobranca_por_palavra.ts";
import { DEFAULT_TIMEZONE, isOpenAt } from "./protocols/context.ts";
import { callTool, initMCP, type MCPServer } from "./tools/mcp.ts";
import { Toolbox } from "./tools/index.ts";
import { transferToHumanAgentImplementation } from "./tools/handoff.ts";
import { avisarAEquipe } from "../_shared/avisar.ts";
import type {
  ConversationExtra,
  OrganizationExtra,
} from "../_shared/types/extra_types.ts";
import { z } from "zod";
import { Ajv2020 } from "ajv";
import type { AgentRowWithExtra, ResponseContext } from "./protocols/base.ts";
import { getFileMetadata } from "../_shared/media.ts";
import { type MessageRowV0, toV1 } from "../_shared/messages-v0.ts";
import { sugerirRetorno } from "./sugerir_retorno.ts";

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
/**
 * As duas recusas da cobrança, ditas para quem tem uma tesoura na mão.
 *
 * `check_limit` estoura com "Insufficient balance for ai_credits" e "Usage
 * limit reached for messages". São frases de banco de dados, em inglês, e quem
 * as lê é o dono da barbearia — na nota interna dentro da conversa, no momento
 * exato em que o cliente ficou sem resposta.
 *
 * A frase vem na frente e o texto técnico continua embaixo: ela diz ao dono o
 * que houve e o que fazer; ele me diz, semanas depois, em que etapa quebrou.
 *
 * Português porque é o idioma de quem opera hoje, como no aviso por push. Sai
 * daqui para o idioma da organização quando houver o segundo país.
 * - 2026/08/18
 */
function oQueACobrancaQuerDizer(cru: string): string | null {
  if (cru.includes("Insufficient balance for ai_credits")) {
    return "O crédito de inteligência artificial acabou. O assistente não vai" +
      " responder até a recarga — as mensagens dos clientes continuam" +
      " chegando normalmente, e ficam esperando alguém da equipe.";
  }

  if (cru.includes("Usage limit reached for messages")) {
    return "A cota de mensagens do plano acabou neste mês. Os envios estão" +
      " sendo recusados até a virada do mês ou a troca de plano.";
  }

  return null;
}

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
 *
 * ## O critério mudou em 2026/08/11, e é isso que importa aqui
 *
 * Este é o quarto remendo nesta expressão, e os três primeiros foram do mesmo
 * feitio: uma medição mostrava uma frase escapando, e eu acrescentava aquela
 * variante. A quarta foi "Vou confirmar o valor do corte + barba com a equipe e
 * já te respondo" — escapou por seis palavras entre o verbo e o "com" (o teto
 * era três) e por "respondo" no lugar de "retorno".
 *
 * O defeito não era a expressão, era o CRITÉRIO dela. Ela vinha sendo afinada
 * para evitar falso positivo — o teto de três palavras existia exatamente para
 * isso, e está escrito abaixo. Mas os dois erros não custam a mesma coisa:
 *
 *   falso positivo → uma conversa transferida à toa, que alguém fecha em dois
 *                    segundos ao ver que já estava resolvida
 *   falso negativo → um cliente esperando para sempre uma pessoa que nunca foi
 *                    chamada, e que ninguém sabe que ele espera
 *
 * Com essa assimetria, precisão é o alvo errado. A expressão passa a ser
 * generosa de propósito: oito palavras de folga entre o verbo e o "com", e toda
 * forma de "eu te falo depois" que apareceu. Se ela transferir demais, o
 * conserto é lê-la de novo; se transferir de menos, o conserto é um cliente
 * perdido que ninguém contou.
 *
 * E vale dizer o teto disto: expressão regular não converge em linguagem
 * natural. Ela vai errar de novo. O que a torna aceitável é a rede embaixo —
 * o piso de 2026/08/11 garante que o cliente recebe alguma coisa mesmo quando
 * tudo isto falha junto.
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
  // Oito palavras entre o verbo e o "com", e não três: "confirmar o valor do
  // corte + barba com a equipe" tem seis, e é promessa das mais claras. Uma
  // frase que por acaso tenha as duas pontas a oito palavras de distância e
  // fale de equipe quase certamente está prometendo isso mesmo — e se não
  // estiver, custa uma transferência à toa.
  /(confirm\w+|verific\w+|falar|checar|perguntar)(\s+\S+){0,8}\s+com\s+(a\s+|o\s+|um\s+|uma\s+)?(equipe|time|colega|profissional|respons\S*|gerente|dono|pessoal)|vou\s+(chamar|passar|encaminhar|transferir)|(estou|vou)\s+transferindo|transferindo\s+(voc[êe]|sua|seu|isso|a\s+conversa)|(j[áa]|te)\s+(retorno|respondo|aviso|falo)|volto\s+a\s+(falar|te)|assim\s+que\s+(souber|confirmar|a\s+equipe)|(dou|dar)\s+(um\s+)?retorno/i;

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

  /**
   * Ninguém vai responder — mas o "me chama às 19" não pode se perder.
   *
   * As quatro saídas abaixo têm a mesma consequência invisível: sem assistente
   * no caminho, `schedule_follow_up` nunca é chamada, e um cliente que pediu
   * retorno fica esperando uma mensagem que nenhuma parte do sistema vai
   * mandar. Aqui não sai nada — fica um bilhete na conversa, e quem atende
   * confirma num toque. Ver `sugerir_retorno.ts`.
   */
  const deixarBilhete = () =>
    sugerirRetorno({
      client,
      conversationId: conv.id,
      // `?.` porque a garantia de que `extra` existe só é feita mais abaixo, e
      // o bilhete é deixado antes disso.
      timeZone: org.extra?.timezone,
      texto: (incoming.content as TextPart | null)?.text,
    });

  // CHECK IF CONVERSATION IS PAUSED

  if (
    conv.extra.paused &&
    +new Date(conv.extra.paused) > +new Date() - PAUSED_CONV_WINDOW
  ) {
    log.info(`Conversation ${conv.id} is paused. Skipping response.`);

    await deixarBilhete();

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

  /**
   * Se o assistente vai falar, ele fala sozinho.
   *
   * Medido na primeira conversa de WhatsApp de verdade, 2026/08/08 às 20:38.
   * O cliente escreveu "Oi" e recebeu três mensagens em doze segundos:
   *
   *   Olá! Conte pra gente como podemos ajudar que já respondemos.
   *   Agora estamos fechados. Deixe sua mensagem que respondemos assim que abrirmos.
   *   Oi, tudo bem? Como posso ajudar você hoje.
   *
   * A primeira e a terceira dizem a mesma coisa. A segunda promete uma espera
   * que a terceira desmente dois segundos depois. Para quem recebe, três
   * mensagens automáticas seguidas para um "oi" é a assinatura de robô — e a
   * do meio ainda mente.
   *
   * Os dois cartazes existem para quando NÃO há quem responda: sem assistente,
   * ou com ele pausado fora de hora, dizer "recebemos, já respondemos" é a
   * coisa certa. Com ele ativo, viram ruído.
   *
   * Fechado, o assistente não fica sem o que dizer: ele já recebe `open_now` e
   * os próximos dias abertos no contexto, e responder "a gente abre terça às
   * 9h, quer que eu já deixe marcado?" atende melhor que um cartaz pedindo
   * para esperar. - 2026/08/08
   */
  const fechadoAgora = org.extra.business_hours?.length
    ? !isOpenAt(
      org.extra.business_hours,
      org.extra.timezone || DEFAULT_TIMEZONE,
    )
    : false;

  // Subiu de onde estava (logo antes da escolha do agente) porque a decisão
  // sobre os cartazes depende dela. A verificação de "não há nenhum" continua
  // lá embaixo, junto das outras que interrompem a resposta.
  const aiAgents = agents.filter((agent) => agent.ai) as AgentRowWithExtra[];

  const assistenteVaiResponder =
    aiAgents.some((a) =>
      conv.service === "local" || a.extra?.mode !== "inactive"
    ) &&
    !(fechadoAgora && org.extra.pause_agent_when_closed);

  /**
   * De quem são os cartazes automáticos — e por que isso não é detalhe.
   *
   * `pause_conversation_on_human_message` pausa a conversa por 12 horas quando
   * sai uma mensagem sem `agent_id`, porque é assim que chega o eco do que um
   * humano digitou no aplicativo do WhatsApp Business. A regra é boa: se
   * alguém digitou, o assistente cala a boca.
   *
   * Os cartazes iam sem `agent_id`, e ficavam indistinguíveis de um humano
   * digitando. Medido em 2026/08/08 na primeira conversa real: o aviso de
   * fechado saiu às 20:38:15 e a conversa foi pausada no mesmo instante. As
   * três mensagens seguintes do cliente — 20:54, 22:11, 22:11 — chegaram ao
   * banco e não tiveram resposta nenhuma. Do lado de fora, o número
   * simplesmente morreu.
   *
   * Nenhum teste podia pegar isto: o gatilho não dispara em `service = local`
   * (linha explícita na definição dele), e é em `local` que rodam as quatro
   * suítes. O primeiro WhatsApp de verdade foi o primeiro lugar onde deu para
   * ver.
   *
   * Com o dono certo, o cartaz é do assistente e não pausa nada. - 2026/08/08
   */
  const donoDoCartaz = aiAgents.find((a) =>
    a.id === conv.extra?.default_agent_id
  ) ??
    aiAgents.find((a) => a.extra?.mode !== "inactive") ??
    aiAgents.at(0);

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
  /**
   * # A sequência que a palavra do cliente dispara
   *
   * A barbearia monta a sequência na biblioteca e diz quais palavras a chamam.
   * "quanto custa o corte?" faz sair o áudio dos preços e a foto da tabela,
   * com a pausa que ela escolheu entre um e outro.
   *
   * ## Ela tem precedência sobre o assistente
   *
   * A primeira versão cedia: só disparava quando o assistente não ia
   * responder. O efeito era o recurso nunca funcionar, porque loja com
   * assistente ativo é o caso normal — e o dono concluiria que está quebrado.
   *
   * A sequência é uma resposta que ELE escreveu à mão para uma pergunta que
   * sabe que se repete. Casou a palavra, ela é a resposta daquele turno e o
   * modelo nem é chamado: não há como se atropelarem, e a chamada é
   * economizada.
   *
   * ## Uma vez por conversa
   *
   * Sem isso, quem escreve "preço" três vezes recebe a mesma sequência três
   * vezes — e a segunda já não é atendimento, é disparo. O que saiu fica
   * marcado no `extra` da conversa.
   *
   * ## A pausa vira hora futura
   *
   * O passo sem pausa sai agora; o com pausa é gravado com carimbo no futuro e
   * entregue pela varredura de minuto em minuto. É o mesmo caminho que a tela
   * usa quando quem dispara é uma pessoa. - 2026/08/18
   */
  const jaDisparadas: string[] =
    (conv.extra as { sequencias_disparadas?: string[] } | null)
      ?.sequencias_disparadas ?? [];

  const textoDoCliente = messages
    .filter((m) => m.direction === "incoming")
    .map((m) => (m.content as { text?: string } | null)?.text ?? "")
    .at(-1) ?? "";

  const sequencia = sequenciaPara(textoDoCliente, org.extra.quick_combos);

  if (sequencia && !jaDisparadas.includes(sequencia.name)) {
    const passos = passosComHora(sequencia, {
      frases: org.extra.quick_messages ?? [],
      midias: (org.extra.quick_media ?? []) as {
        uri: string;
        name: string;
        mime_type: string;
        size: number;
        kind: string;
      }[],
    });

    log.info("Sequência por palavra", sequencia.name, passos.length, "passo(s)");

    for (const passo of passos) {
      // A pausa curta é esperada AQUI, na função: agendar trinta segundos daria
      // "algum momento no próximo minuto", porque a varredura roda de minuto em
      // minuto. Ver ESPERA_NO_ENVIO.
      if (passo.dormir) {
        await new Promise((pronto) => setTimeout(pronto, passo.dormir * 1000));
      }

      const linha: MessageInsert = {
        organization_id: conv.organization_id,
        conversation_id: conv.id,
        service: conv.service,
        organization_address: conv.organization_address,
        contact_address: conv.contact_address,
        direction: "outgoing",
        // Ver `donoDoCartaz`: sem isto o gatilho pausa a conversa por 12 horas.
        agent_id: donoDoCartaz?.id ?? null,
        content: passo.content as MessageInsert["content"],
        // Só quando agenda. Sem carimbo, o banco põe a hora da inserção — que
        // depois de uma espera é a hora certa. Ver passosComHora.
        ...(passo.quando ? { timestamp: passo.quando.toISOString() } : {}),
      };

      await client.from("messages").insert(linha).throwOnError();
    }

    // Marcada só DEPOIS de gravar: marcar antes e falhar no meio deixaria a
    // conversa achando que já mandou o que não mandou, e sem segunda chance.
    if (passos.length) {
      await client
        .from("conversations")
        .update({
          extra: { sequencias_disparadas: [...jaDisparadas, sequencia.name] },
        })
        .eq("id", conv.id)
        .throwOnError();

      // A sequência FOI a resposta deste turno. Seguir daqui chamaria o modelo
      // para responder o que já foi respondido.
      return new Response(
        JSON.stringify({ sequencia: sequencia.name, passos: passos.length }),
        { headers: { "content-type": "application/json" } },
      );
    }
  }

  /**
   * # A cobrança que dispara por palavra
   *
   * "Quanto é o corte?" e sai o Pix de R$ 45. O preço vem do catálogo de
   * serviços — o mesmo que a agenda usa para marcar —, então mudar o preço num
   * lugar muda nos dois. As palavras que disparam moram em cada serviço.
   *
   * ## Depois da sequência, e antes do assistente
   *
   * Depois da sequência porque ela é a configuração mais específica: quem
   * montou um funil para "preço" quis o funil, e não uma cobrança seca. Antes
   * do assistente pelo mesmo motivo que a sequência: casou a palavra, a
   * resposta daquele turno É a cobrança, e chamar o modelo depois seria
   * responder duas vezes — uma delas com um preço escrito à mão que pode
   * divergir do catálogo.
   *
   * ## Uma vez por serviço, por conversa
   *
   * Mesma trava da sequência, e com a mesma limitação conhecida: o cliente que
   * voltar daqui a um mês e perguntar do mesmo corte não recebe de novo. É
   * troca deliberada — receber duas cobranças iguais na mesma conversa parece
   * cobrança dobrada, que assusta mais do que a ausência incomoda. Perguntar
   * de outro serviço dispara normalmente.
   *
   * Sem chave Pix cadastrada, `mensagensDaCobranca` devolve nada e o
   * assistente segue: ele responde o preço em palavras, como já fazia. Mandar
   * "o Pix é" sem o Pix seria pior que não mandar. - 2026/08/18
   */
  const jaCobradas: string[] =
    (conv.extra as { cobrancas_disparadas?: string[] } | null)
      ?.cobrancas_disparadas ?? [];

  const servico = servicoPara(
    textoDoCliente,
    org.extra.appointments?.services,
  );

  if (servico && !jaCobradas.includes(servico.name)) {
    const textos = mensagensDaCobranca(
      servico,
      org,
      conv.id.replaceAll("-", "").slice(0, 12),
    );

    if (textos) {
      for (const texto of textos) {
        const outgoing: MessageInsert = {
          organization_id: conv.organization_id,
          conversation_id: conv.id,
          service: conv.service,
          organization_address: conv.organization_address,
          contact_address: conv.contact_address,
          direction: "outgoing",
          agent_id: donoDoCartaz?.id ?? null,
          content: { version: "1", type: "text", kind: "text", text: texto },
        };

        // Em série: a segunda mensagem é o código, e ela tem de chegar DEPOIS
        // do aviso. Em paralelo o código chegaria primeiro em metade das vezes.
        await client.from("messages").insert(outgoing).throwOnError();
      }

      // Marcado só depois de gravar, como na sequência: marcar antes e falhar
      // no meio deixaria a conversa achando que cobrou o que não cobrou.
      await client
        .from("conversations")
        .update({
          extra: { cobrancas_disparadas: [...jaCobradas, servico.name] },
        })
        .eq("id", conv.id)
        .throwOnError();

      log.info("Cobrança por palavra", { servico: servico.name });

      return new Response(
        JSON.stringify({ cobranca: servico.name, preco: servico.price }),
        { headers: { "content-type": "application/json" } },
      );
    }
  }

  /**
   * O interruptor da tela vale mais do que o texto escrito.
   *
   * `_off` ausente é LIGADA — escolhido assim para que nenhuma loja que já tem
   * frase escrita parasse de mandar por causa desta linha. Ver
   * `OrganizationExtra`. - 2026/08/18
   */
  if (
    org.extra.welcome_message &&
    !org.extra.welcome_message_off &&
    !assistenteVaiResponder &&
    messages.every((m) => m.direction !== "outgoing")
  ) {
    const outgoing: MessageInsert = {
      organization_id: conv.organization_id,
      conversation_id: conv.id,
      service: conv.service,
      organization_address: conv.organization_address,
      contact_address: conv.contact_address,
      direction: "outgoing",
      // Ver `donoDoCartaz`: sem isto o gatilho pausa a conversa por 12 horas.
      agent_id: donoDoCartaz?.id ?? null,
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

      if (
        org.extra.away_message &&
        !org.extra.away_message_off &&
        !sentRecently &&
        !assistenteVaiResponder
      ) {
        const outgoing: MessageInsert = {
          organization_id: conv.organization_id,
          conversation_id: conv.id,
          service: conv.service,
          organization_address: conv.organization_address,
          contact_address: conv.contact_address,
          direction: "outgoing",
          // Ver `donoDoCartaz`: sem isto o gatilho pausa a conversa por 12
          // horas — e foi exatamente este cartaz que calou o número real.
          agent_id: donoDoCartaz?.id ?? null,
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

        await deixarBilhete();

        return new Response("ok", { headers: corsHeaders });
      }
    }
  }

  // CHECK IF THERE ARE AI AGENTS

  if (!aiAgents.length) {
    log.info(
      `No AI agents found for conversation ${conv.id}. Skipping response.`,
    );

    await deixarBilhete();

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

    await deixarBilhete();

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

  /**
   * Quem atende nesta loja.
   *
   * Vai no contexto, e não numa ferramenta, pela mesma razão dos compromissos
   * do contato: o assistente precisa saber que existe equipe ANTES de escrever
   * a primeira frase. Sem isso, o cliente que pede "com o Jorge" recebe uma
   * pergunta de volta sobre quem é Jorge — e a loja de uma pessoa, que não tem
   * ninguém cadastrado, não recebe campo nenhum e segue como antes.
   *
   * Só o nome. Serviço por pessoa é o que a ferramenta usa para decidir, e
   * repetir isso aqui daria ao modelo mais uma coisa para contradizer.
   * - 2026/08/09
   */
  const { data: equipe } = await client
    .from("professionals")
    .select("name")
    .eq("organization_id", organization_id)
    .eq("active", true)
    .order("created_at");

  const context = {
    organization,
    conversation,
    messages,
    contact,
    agent: agent as AgentRowWithExtra,
    appointments,
    professionals: equipe?.map((pessoa) => pessoa.name as string),
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

      /**
       * A última rodada é sem ferramenta nenhuma, e por isso ele responde.
       *
       * O teto de dez rodadas existia para o laço não correr para sempre, e
       * quando ele estourava o cliente ficava mudo: o assistente tinha gastado
       * as dez chamando ferramenta atrás de ferramenta sem nunca escrever uma
       * frase. Medido em 2026/08/11, numa corrida de 25 minutos: 6 silêncios em
       * 132 respostas, e 4 deles eram exatamente isto — "o laço terminou em 6,
       * 8 e 11 rodadas sem escrever nada".
       *
       * Instrução não resolveria, e nem tentei: o modelo não está desobedecendo
       * uma ordem, está perdido numa busca. O que resolve é tirar a saída.
       * Chegando na última rodada ele recebe a lista de ferramentas VAZIA, e
       * como `respond` é obrigatória e é a única que sobra, a única coisa que
       * ele pode fazer é falar com o cliente — com o que já descobriu nas nove
       * anteriores, que costuma ser bastante.
       *
       * É a mesma lição do `taken`: enquanto a porta errada estiver aberta,
       * alguma hora ele passa por ela. Some com a porta. - 2026/08/11
       */
      const ultimaChance = iteration === max_iterations;

      if (ultimaChance) {
        log.warn(
          `Round ${iteration} of ${max_iterations}: tools withdrawn so the contact gets an answer.`,
        );
      }

      const handler = ProtocolFactory.getHandler(
        ultimaChance ? [] : tools,
        context,
        client,
      );

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
            text: ((cru) => {
              const emPortugues = oQueACobrancaQuerDizer(cru);

              return emPortugues ? `${emPortugues}\n\n${cru}` : cru;
            })(describeError(error) + ` (etapa: ${step})`),
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
     *
     * REVISTO EM 2026/08/11, e a última frase acima é a que caiu. Ela valia
     * quando o silêncio era 1 em 30 e a transferência acabara de nascer. Medido
     * numa corrida de 25 minutos: 6 silêncios em 132 respostas — 4,5%, um
     * cliente em vinte e dois. E a pessoa que a transferência chama não existe
     * às 21h de um sábado.
     *
     * O que sai agora não é o sistema pedindo desculpas: é uma frase que o DONO
     * escreveu, guardada em `silence_message`, que não passa por modelo nenhum
     * e por isso não pode falhar. Silêncio vira conversa segurada. Quem não
     * escreveu frase nenhuma continua no comportamento antigo.
     */
    /**
     * Quando o assistente já transferiu, a rede não transfere de novo.
     *
     * Ela grava `kind: cannot_resolve`, e o `extra.handoff` inteiro é
     * substituído — então a classificação do modelo era apagada pela nossa
     * própria proteção. Medido em 2026/08/10, numa reclamação: o modelo
     * chamou a ferramenta com `complaint`, estourou o limite de tokens ao
     * escrever a resposta, e a rede regravou por cima. Na lista, a conversa
     * que devia estar vermelha apareceu cinza — e vermelho é justamente o que
     * faz alguém pegá-la primeiro.
     *
     * Não há o que transferir aqui: a conversa já está pausada e já espera
     * uma pessoa. O que falta é a nota interna dizendo que o contato ficou sem
     * resposta, e essa continua sendo escrita abaixo. - 2026/08/10
     */
    /**
     * O piso: a frase do dono sai ANTES de qualquer outra coisa.
     *
     * Antes da transferência de propósito. Se a transferência falhar — e ela
     * falha, é uma escrita no banco como outra qualquer — o cliente já terá
     * recebido alguma coisa. A ordem inversa faria o piso depender justamente
     * do que ele existe para cobrir.
     *
     * Uma vez por conversa em silêncio, e não uma por falha: um cliente que
     * escreve três vezes seguidas num minuto ruim receberia a mesma frase três
     * vezes, que é pior que recebê-la uma. Basta olhar se a última coisa que
     * saiu daqui já foi ela.
     */
    // `?.` mesmo com `extra` sendo `not null` no banco: este bloco existe para
    // o caminho em que tudo já deu errado, e é o último lugar do sistema onde
    // vale confiar numa garantia de esquema.
    const fraseDoPiso = (org.extra as OrganizationExtra | null)
      ?.silence_message_off
      ? undefined
      : (org.extra as OrganizationExtra | null)?.silence_message?.trim();

    if (fraseDoPiso) {
      const { data: ultimas } = await client
        .from("messages")
        .select("content")
        .eq("conversation_id", conv.id)
        .eq("direction", "outgoing")
        .order("timestamp", { ascending: false })
        .limit(1);

      const jaSaiu = (ultimas?.[0]?.content as { text?: string } | undefined)
        ?.text?.trim() === fraseDoPiso;

      if (!jaSaiu) {
        const { error } = await client.from("messages").insert({
          organization_id,
          conversation_id: conv.id,
          service: conv.service,
          organization_address: conv.organization_address,
          contact_address: conv.contact_address,
          direction: "outgoing" as const,
          agent_id: agent.id,
          content: {
            version: "1" as const,
            type: "text" as const,
            kind: "text" as const,
            text: fraseDoPiso,
          },
        });

        if (error) {
          log.error("Falha ao enviar a frase de piso", {
            conversation_id: conv.id,
            error: describeError(error),
          });
        }
      }
    }

    let chamouAlguem = handedOff;

    if (!handedOff) {
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
          handedOff
            ? "O próprio assistente já havia transferido a conversa: ela está esperando uma pessoa, com o motivo que ele registrou."
            : chamouAlguem
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

  /**
   * Puxar alguém, quando ninguém está olhando a tela.
   *
   * Aqui embaixo de propósito: é o único ponto em que os dois caminhos já se
   * resolveram — o assistente transferindo por conta, e a rede transferindo
   * pelo silêncio. Avisar lá em cima seria avisar duas vezes pela mesma
   * conversa, ou avisar com a classificação que ainda ia mudar.
   *
   * Lê o `kind` do banco em vez de deduzir das variáveis daqui: quem gravou por
   * último é quem manda, e foi exatamente confiar na dedução que fez a
   * reclamação chegar cinza em 2026/08/10.
   *
   * `await` e não solto: a função de borda morre quando a resposta sai, e um
   * envio começado sem espera morreria junto. São dezenas de milissegundos, e
   * o contato já recebeu o que tinha de receber. - 2026/08/10
   */
  if (handedOff || !answeredContact) {
    try {
      const [{ data: estado }, contato] = await Promise.all([
        client
          .from("conversations")
          .select("extra")
          .eq("id", conv.id)
          .single(),
        Promise.resolve(conv.name ?? conv.contact_address),
      ]);

      const kind = (estado?.extra as ConversationExtra | null)?.handoff?.kind;

      await avisarAEquipe(
        client,
        organization_id,
        // Sem `kind` gravado, o que houve foi silêncio: ninguém declarou nada e
        // o contato ficou sem resposta.
        kind ?? "silence",
        { conversationId: conv.id, contato },
      );
    } catch (error) {
      // Aviso que falha não pode derrubar a resposta: quem esperava era o
      // cliente, e ele já foi atendido.
      log.warn("Falha ao avisar a equipe", { error: describeError(error) });
    }
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
