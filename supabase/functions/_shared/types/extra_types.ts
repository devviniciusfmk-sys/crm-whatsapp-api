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

export type ContactExtra = Record<PropertyKey, never>;

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
  protocol?: "chat_completions" | "responses";
  max_messages?: number;
  temperature?: number;
  max_tokens?: number;
  thinking?: "minimal" | "low" | "medium" | "high";
  instructions?: string;
  send_inline_files_up_to_size_mb?: number;
  tools?: ToolConfig[];
};
