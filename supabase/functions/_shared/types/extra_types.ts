import type { Database as DatabaseGenerated } from "../db_types.ts";
import type { SQLToolConfig } from "../../agent-client/tools/sql.ts";

//===================================
// Extra
//===================================

export type Memory = {
  [key: string]: string | undefined | Memory;
};

export type PreprocessingConfig = {
  mode?: "active" | "inactive";
  model?: "gemini-2.5-pro" | "gemini-2.5-flash";
  api_key?: string;
  language?: string;
  extra_prompt?: string;
};

/**
 * Opening hours, seven entries, **Sunday first** — the order
 * `Date.getDay()` and `Intl` both use, so no index has to be translated
 * anywhere. `null` means closed that day.
 *
 * Times are "HH:mm" wall-clock in the organization's own timezone, never UTC:
 * a business says "we close at six", and six does not move when the clocks do.
 *
 * One range per day. Places that shut for lunch exist, and this cannot express
 * them; two ranges would double the form for a case that is not the common one
 * and can be spelled out in the agent's instructions meanwhile.
 *
 * `to` earlier than `from` means the day runs past midnight (a bar open 18:00
 * to 02:00), which is why the check has to look at the previous day too.
 */
export type BusinessHours = ({ from: string; to: string } | null)[];

export type OrganizationExtra = {
  response_delay_seconds?: number;
  welcome_message?: string;
  authorized_contacts_only?: boolean;
  default_agent_id?: string;
  media_preprocessing?: PreprocessingConfig;
  error_messages_direction?: "internal" | "outgoing";
  /**
   * IANA timezone, e.g. "America/Sao_Paulo". Everything the agent is told
   * about time is rendered in it.
   *
   * Until this existed the agent was handed `now` in UTC, so for a Brazilian
   * business every hour it reasoned about was three off — nine at night read
   * as midnight, and the day had already rolled over. Nothing failed loudly;
   * it just answered as if it were tomorrow. - 2026/08/01
   */
  timezone?: string;
  /**
   * O que mais o cliente pergunta e o sistema não tem onde guardar.
   *
   * Estacionamento, wifi, formas de pagamento, se tem sala de espera, se pode
   * levar criança, onde fica a entrada. Nada disso cabe em catálogo nem em
   * horário, e sem lugar para morar o assistente fazia uma de duas coisas, as
   * duas ruins: chamava uma pessoa para responder "temos estacionamento?" —
   * ninguém aparece às onze da noite — ou inventava. Medido em 2026/08/09:
   * perguntado sobre estacionamento, respondeu "não temos estacionamento no
   * salão", que ele não tinha como saber.
   *
   * Texto livre e um campo só, de propósito. Estacionamento, wifi e pagamento
   * são os três primeiros de uma lista sem fim, e caixa de marcar para cada um
   * seria uma tela nova a cada pergunta nova. Quem atende escreve como fala, e
   * o assistente recebe isso como fato do negócio. - 2026/08/09
   */
  business_facts?: string;
  business_hours?: BusinessHours;
  /**
   * Sent when someone writes outside `business_hours`. Empty means the feature
   * is off — there is no separate switch, because a message nobody wrote is a
   * message nobody wants sent.
   *
   * The WhatsApp Business *app* has this natively; the Cloud API this talks to
   * does not, so it lives here. Delivered exactly like `welcome_message`.
   */
  away_message?: string;
  /**
   * Whether the agent also stays quiet outside opening hours.
   *
   * Both answers are legitimate and they are not the same product: a shop that
   * wants the bot selling at 3am needs it false, while one that wants the
   * WhatsApp Business behaviour — a notice and nothing else — needs it true.
   */
  pause_agent_when_closed?: boolean;
  /**
   * Lembrete de compromisso, escolhido na tela de configurações.
   *
   * Precisa ser modelo aprovado: um lembrete de véspera cai fora da janela de
   * 24 horas da Meta, onde texto livre não passa. Sem `template` está
   * desligado.
   *
   * `variables` é gravado por quem escolheu o modelo, e não descoberto aqui:
   * perguntar à Meta a cada agendamento custaria uma ida à rede para saber
   * algo que já era sabido. As variáveis são preenchidas em ordem fixa —
   * {{1}} nome, {{2}} data, {{3}} hora.
   */
  appointment_reminder?: {
    template?: string;
    language?: string;
    hours_before?: number;
    variables?: number;
  };
  /**
   * Quanto tempo um compromisso ocupa, e quanto sobra depois dele.
   *
   * Sem isto a duração vinha do modelo em cada agendamento — e quando ele não
   * a mandava, meia hora era assumida no código. Numa organização que atende
   * duas horas por cliente, isso é o bastante para marcar o segundo em cima do
   * primeiro: os `starts_at` são diferentes, a sobreposição não aparecia, e
   * duas pessoas chegavam para o mesmo horário. Instrução no prompt não
   * resolve, porque cada organização escreve as suas e nem todas escrevem
   * esta.
   *
   * `services` é o que tira a conta do modelo de vez: com catálogo, a duração
   * sai do nome do serviço e o `duration_minutes` que o modelo mandar é
   * ignorado. Sem catálogo — que é o caso de quem atende sempre o mesmo tempo
   * — vale `default_minutes`.
   *
   * A folga conta DEPOIS do compromisso: é o tempo de arrumar entre um cliente
   * e o próximo, e não entra na conta do horário de fechamento (arrumar depois
   * de fechar é trabalho de quem fica, não de quem marca). - 2026/08/03
   */
  appointments?: {
    /** Duração quando o serviço não disser outra, em minutos. */
    default_minutes?: number;
    /** Folga depois de cada compromisso, em minutos. */
    buffer_minutes?: number;
    /**
     * Serviços com duração própria. Vazio significa "todos duram o padrão".
     *
     * `price` é o valor sugerido, e vai para o compromisso na hora de marcar —
     * o preço de lá é que vale depois, porque preço muda e o histórico tem de
     * continuar dizendo o que foi cobrado naquele dia. Ausente é serviço sem
     * preço cadastrado, e o compromisso nasce sem valor.
     */
    services?: { name: string; minutes: number; price?: number }[];
  };
};

export type WhatsAppOrganizationAddressExtra = {
  waba_id?: string;
  business_id?: string;
  phone_number?: string;
  verified_name?: string;
  // "manual" is the connection made by pasting a system user token instead of
  // going through Meta's dialog — see whatsapp-management/manual_signup.ts.
  flow_type?:
    | "only_waba"
    | "new_phone_number"
    | "existing_phone_number"
    | "manual";
  /** ISO, or null when the token never expires. Only set by the manual flow. */
  token_expires_at?: string | null;
  // No `access_token` here on purpose: the Meta token is a Vault secret, read
  // through `getWhatsAppAccessToken` (_shared/whatsapp_token.ts). `extra` is
  // member-readable via RLS and is echoed to customer webhooks.
  callback_url?: string | null;
  verify_token?: string | null;
};

export type InstagramOrganizationAddressExtra = {
  ig_user_id?: string;
  username?: string;
  name?: string;
  profile_picture_url?: string;
  access_token?: string; // Per-IG-account OAuth user token (long-lived, 60 days)
  token_expires_at?: string; // ISO; when the long-lived token expires
  token_refreshed_at?: string; // ISO; last successful refresh (or initial issue)
  scopes?: string[]; // granted permissions
  needs_reauth?: string; // ISO; set when a refresh failed and re-login is required
};

// Union — the column accepts either shape; consumers narrow via the row's
// `service` column (or via a cast at WA-/IG-specific read sites).
export type OrganizationAddressExtra =
  | WhatsAppOrganizationAddressExtra
  | InstagramOrganizationAddressExtra;

export type ConversationExtra = {
  memory?: Memory;
  paused?: string;
  archived?: string;
  pinned?: string;
  default_agent_id?: string;
  // Written by the `transfer_to_human_agent` tool. Kept separate from `paused`
  // on purpose: `paused` alone cannot say who paused, and the difference
  // matters to whoever opens the list. A conversation someone muted by hand
  // needs nothing; one the agent gave up on is waiting for a person, and it
  // says so here, along with what it could not resolve.
  handoff?: {
    at: string;
    reason: string;
    /**
     * De que tipo é o pedido, escolhido pelo modelo ao transferir.
     *
     * Opcional porque conversas transferidas antes de 2026/08/08 não têm o
     * campo, e porque as duas transferências que o `index.ts` faz sozinho —
     * promessa sem chamada e silêncio — não passam pelo modelo. Quem lê trata
     * a ausência como `cannot_resolve`.
     */
    kind?: "complaint" | "wants_person" | "cannot_resolve";
    agent_id: string;
  };
  /**
   * When the out-of-hours notice was last sent to this conversation. Without
   * it the notice repeats on every message, which is the behaviour that makes
   * people block a number.
   */
  away_sent?: string;
  /*
  test_run?: {
    reference_conversation: {
      organization_address: string;
      contact_address: string;
    };
    status?: "fail" | "success";
    reference_message_id?: string;
  };
  */
};

/**
 * A ficha do cliente.
 *
 * Estava declarada como objeto vazio enquanto `save_contact_details` já gravava
 * e-mail, documento e endereço aqui, e a tela já os exibia. Tipo que mente não
 * protege ninguém: quem fosse ler um campo daqui levava um erro de compilação
 * por um dado que existe no banco desde ontem. - 2026/08/04
 */
export type ContactExtra = {
  email?: string;
  /** CPF ou CNPJ, como a pessoa informou. */
  document?: string;
  /** O endereço como o cliente escreveu na conversa. */
  address?: string;
  cep?: string;
  street?: string;
  address_number?: string;
  complement?: string;
  district?: string;
  city?: string;
  state?: string;
  /** Nascimento em ISO (AAAA-MM-DD). */
  birthday?: string;
  /** Observação escrita por quem atende. Máquina nenhuma sobrescreve. */
  notes?: string;
  /**
   * O que o sistema aprendeu deste cliente, em poucas linhas.
   *
   * Existe para o assistente não reler a conversa inteira a cada mensagem. Uma
   * conversa de seis meses não cabe na janela de contexto, e o que cabe é
   * sempre o pedaço errado — o começo, onde a pessoa disse que é alérgica,
   * é o primeiro a sair. Cinco linhas atravessam meses; duzentas mensagens não.
   *
   * Separado de `notes` de propósito: `notes` é o que uma pessoa escreveu, e
   * uma máquina não reescreve o que uma pessoa escreveu. É a mesma separação de
   * `address` (o que o cliente disse) e `street` (o que a equipe conferiu).
   *
   * Editável e apagável na ficha: é texto sobre uma pessoa, gerado por máquina,
   * e quem atende tem de poder corrigir e remover. - 2026/08/04
   */
  summary?: string;
  /** Quando o resumo foi refeito, em ISO. */
  summary_at?: string;
};

export type WhatsAppContactAddressExtra = {
  name?: string;
  username?: string;
  phone_number?: string;
  bsuid?: string;
  address_type?: "phone" | "bsuid";
  synced?: { // if the contact address was synced from WhatsApp
    name: string;
    action: "add" | "remove";
  };
  replaces_address?: string;
  replaced_by_address?: string;
};

export type InstagramContactAddressExtra = {
  name?: string;
  username?: string;
  biography?: string;
  profile_picture_url?: string;
  // ISO timestamp — set on every fetch (success or failure) so the TTL guard
  // suppresses retries until the refresh window elapses.
  name_fetched_at?: string;
  replaces_address?: string;
  replaced_by_address?: string;
};

// Union — the column accepts either shape; consumers narrow via the row's
// `service` column (or via the per-service Row/Insert aliases below).
export type ContactAddressExtra =
  | WhatsAppContactAddressExtra
  | InstagramContactAddressExtra;

// Function tools have a JSON input (data part).
export type LocalFunctionToolConfig = {
  provider: "local";
  type: "function";
  name: string;
};

// Custom tools have a free-grammar input (text part).
export type LocalCustomToolConfig = {
  provider: "local";
  type: "custom";
  name: string;
};

export type LocalSimpleToolConfig =
  | LocalFunctionToolConfig
  | LocalCustomToolConfig;

export type LocalMCPToolConfig = {
  provider: "local";
  type: "mcp";
  label: string; // server label
  config: {
    url: string;
    product?: "calendar" | "sheets";
    headers?: Record<string, string>;
    allowed_tools?: string[];
    files?: string[];
    email?: string;
  };
};

export type LocalSQLToolConfig = {
  provider: "local";
  type: "sql";
  label: string; // database label
  config: SQLToolConfig;
};

export type LocalHTTPToolConfig = {
  provider: "local";
  type: "http";
  label: string; // client label
  config: {
    headers?: Record<string, string>;
    url?: string;
    methods?: string[];
  };
};

export type LocalSpecialToolConfig = LocalSQLToolConfig | LocalHTTPToolConfig;

export type ToolConfig =
  | LocalSimpleToolConfig
  | LocalSpecialToolConfig
  | LocalMCPToolConfig;

export type HumanAgentExtra = {
  role: DatabaseGenerated["public"]["Enums"]["role"];
  invitation?: {
    organization_name: string;
    email: string;
    status: "pending" | "accepted" | "rejected";
  };
};

export type AIAgentExtra = {
  mode?: "active" | "draft" | "inactive";
  description?: string;
  api_url?: string;
  api_key?: string;
  model?: string;
  /**
   * Preferência de provedor, repassada verbatim quando o intermediário é a
   * OpenRouter: `order`, `only`, `ignore`, `sort`, `allow_fallbacks`.
   *
   * Existe porque o mesmo modelo acerta ou erra conforme quem o serve — medido,
   * com um provedor devolvendo argumentos corrompidos em 2 de 8 chamadas. O
   * detalhe está no comentário de `chat-completions.ts`. - 2026/08/04
   */
  provider?: Record<string, unknown>;
  /**
   * Os links que o assistente pode mandar: checkout, cardápio, formulário.
   *
   * Fora das instruções de propósito. Colado no meio de trinta linhas de texto,
   * um link de pagamento é a coisa mais frágil do prompt: quem troca o preço
   * mexe no parágrafo errado, quem duplica a campanha esquece de trocar a URL,
   * e o modelo às vezes reescreve o que copia. Aqui ele é dado — a tela mostra
   * um por linha, trocar é editar um campo, e o contexto entrega a URL literal.
   *
   * O rótulo é o que o modelo lê para decidir quando mandar: "Checkout Premium
   * — R$ 29,90, pagamento único" diz mais do que qualquer instrução em volta.
   * - 2026/08/04
   */
  links?: { label: string; url: string }[];
  protocol?: "chat_completions" | "responses";
  max_messages?: number;
  temperature?: number;
  max_tokens?: number;
  thinking?: "minimal" | "low" | "medium" | "high";
  instructions?: string;
  send_inline_files_up_to_size_mb?: number;
  tools?: ToolConfig[];
};
