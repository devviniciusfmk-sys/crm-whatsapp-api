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
 * `to` earlier than `from` means the day runs past midnight (a bar open 18:00
 * to 02:00), which is why the check has to look at the previous day too.
 *
 * ## O almoço, e por que é um buraco e não duas faixas
 *
 * Até 2026/08/10 era uma faixa por dia e nada mais, com o argumento de que duas
 * faixas dobrariam o formulário por um caso incomum. O caso não é incomum:
 * barbearia que fecha das 12h às 13h é a regra, não a exceção, e sem lugar para
 * dizer isso o assistente oferece 12h30 todo dia. O contorno era o dono
 * bloquear o almoço à mão, uma vez por dia, para sempre.
 *
 * `break` e não uma lista de faixas porque o formulário continua sendo um
 * começo, um fim e — atrás de uma caixinha — o buraco do meio. Uma lista pede
 * botão de adicionar, de remover, e ordenação; para expressar exatamente a
 * mesma coisa no único formato que alguém usa. Se um dia aparecer a casa de
 * três turnos, ela vira lista. - 2026/08/10
 */
export type BusinessHours = (
  | { from: string; to: string; break?: { from: string; to: string } }
  | null
)[];

/**
 * Os módulos que um negócio pode ligar.
 *
 * Hoje é um só, e mesmo assim vale a lista: uma barbearia usa agenda, e uma
 * agência que atende no WhatsApp não usa nada disso. Um produto que mostra tudo
 * para todo mundo obriga cada cliente a aprender a ignorar metade dele.
 *
 * `agenda` é o pacote inteiro do "quem marca hora": compromissos, equipe,
 * folgas, lista de espera e lembrete. Eles não se separam — quem marca hora
 * precisa poder bloquear o dentista do barbeiro, e quem não marca não precisa
 * de nenhum dos cinco.
 *
 * Quem obedece a isto hoje é a TELA. Aqui do lado do agente, quais ferramentas
 * ele tem já é decidido por `agents.extra.tools`, que o ramo do negócio
 * preenche na criação — duas chaves para a mesma decisão seriam duas chances de
 * discordarem. O tipo mora aqui para o dia em que algo do agente precisar
 * perguntar. - 2026/08/10
 */
export type ModuleName = "agenda";

export type OrganizationExtra = {
  response_delay_seconds?: number;
  welcome_message?: string;
  authorized_contacts_only?: boolean;
  default_agent_id?: string;
  modules?: ModuleName[];
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
  /**
   * O endereço em partes, porque o número e a referência não vêm do CEP.
   *
   * "Rua das Flores, 123, fundos, ao lado da farmácia" é o que o cliente
   * precisa para chegar, e só a primeira parte o ViaCEP sabe. Separado, cada
   * pedaço tem dono: o CEP preenche rua/bairro/cidade, a pessoa completa
   * número e referência, e nada se sobrescreve na próxima busca.
   */
  business_address?: {
    cep?: string;
    street?: string;
    number?: string;
    /** "fundos", "ao lado da farmácia", "portão azul" — como se acha o lugar. */
    reference?: string;
    district?: string;
    city?: string;
    state?: string;
  };
  /**
   * As perguntas de sempre, com três estados e não dois.
   *
   * Caixa de marcar comum tem "marcado" e "desmarcado", e desmarcado teria de
   * significar "não temos" — o que faria o assistente afirmar ausência de wifi
   * numa loja que só não preencheu o campo. É exatamente a invenção que se
   * consertou em 2026/08/09, de volta pela porta da frente.
   *
   * Ausente é "ninguém disse", e sobre isso ele continua chamando uma pessoa.
   * Só `no` autoriza dizer que não tem. - 2026/08/09
   */
  amenities?: Record<string, "yes" | "no">;
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
   * O piso: o que sai quando o assistente não conseguiu escrever nada.
   *
   * Até 2026/08/11 esse caso terminava em SILÊNCIO. A regra era explícita e
   * tinha razão de ser: "ao contato não se manda pedido de desculpas
   * automático — se o assistente não tem o que dizer, quem diz é uma pessoa".
   * Escrita quando o silêncio era raro e a transferência era nova.
   *
   * A evidência mudou. Numa corrida de 25 minutos: 6 silêncios em 132
   * respostas — 4,5%, ou um cliente em vinte e dois. E a pessoa que a
   * transferência chama não existe às 21h de um sábado: o cliente escreveu
   * para uma barbearia e não ouviu nada.
   *
   * Então o piso não é um pedido de desculpas do sistema, é UMA FRASE DO DONO,
   * escrita por ele, que só sai quando não houve o que dizer. "Recebi sua
   * mensagem, já te respondo." Não pode falhar, porque não passa por modelo
   * nenhum — e transforma silêncio em conversa segurada.
   *
   * Vazio desliga, como as outras duas: mensagem que ninguém escreveu é
   * mensagem que ninguém quer mandar. Os ramos de negócio já nascem com uma.
   */
  silence_message?: string;
  /**
   * Os interruptores das mensagens automáticas.
   *
   * `_off` e não `_on` porque a AUSÊNCIA tem de significar ligada: toda loja
   * que já tem frase escrita continua mandando, sem migração e sem ninguém
   * precisar entrar na tela para reativar o que nunca desativou.
   *
   * Existem porque desligar era apagar a frase, e quem apagava perdia o que
   * tinha escrito. A frase guardada e o envio desligado são coisas diferentes,
   * e até 2026/08/18 o produto só sabia representar uma.
   *
   * `handoff_timeout_message_off` é lido em SQL, na função do prazo de
   * transferência — o texto dele nunca chegou a este arquivo, e o interruptor
   * fica aqui para os quatro serem lidos no mesmo lugar.
   */
  welcome_message_off?: boolean;
  away_message_off?: boolean;
  handoff_timeout_message_off?: boolean;
  silence_message_off?: boolean;
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
    /**
     * O corpo do modelo, com os `{{1}}` no lugar, guardado quando a pessoa
     * escolheu o modelo na tela.
     *
     * Serve para UMA coisa: escrever na conversa o que o cliente vai ler. Sem
     * ele a mensagem enviada aparecia no painel como a lista de variáveis —
     * "Vinícius · 12/08/2026 · 09:52" — e quem abria o chat não via o que tinha
     * sido mandado. Quando o cliente respondia "confirmo", ninguém sabia a quê.
     * Medido em 2026/08/12, no primeiro lembrete que chegou de verdade.
     */
    body?: string;
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
  /**
   * "Ele pediu retorno às 19h" — um bilhete, e não um agendamento.
   *
   * Escrito quando o cliente diz uma hora e NENHUMA assistente vai responder
   * (conversa pausada por um humano, loja fechada, agente inativo ou ausente).
   * Nesses casos `schedule_follow_up` nunca é chamada e a promessa se perde.
   *
   * Nada sai daqui sozinho: a tela mostra um aviso de um toque acima do teclado
   * e quem atende decide. `null` é como a tela o apaga — o `merge_update` grava
   * o nulo na chave em vez de removê-la, e quem lê trata os dois como ausência.
   * Ver `agent-client/sugerir_retorno.ts`.
   */
  retorno_sugerido?: {
    /** Quando sairia, em ISO UTC. */
    em: string;
    /** O trecho da mensagem que foi lido, para o aviso poder se explicar. */
    lido: string;
    criado: string;
  } | null;
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
