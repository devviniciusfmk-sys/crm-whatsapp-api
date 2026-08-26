import type {
  Database as DatabaseGenerated,
  Json,
  Tables,
} from "../db_types.ts";
import { MergeDeep } from "https://esm.sh/type-fest@^4.11.1";
import type {
  IncomingMessage,
  InternalMessage,
  OutgoingMessage,
} from "./message_types.ts";
import type { IncomingStatus, OutgoingStatus } from "./status_types.ts";
import type {
  AIAgentExtra,
  ContactAddressExtra,
  ContactExtra,
  ConversationExtra,
  HumanAgentExtra,
  OrganizationAddressExtra,
  OrganizationExtra,
} from "./extra_types.ts";

export type { Json, Tables };

type AgentExtra = HumanAgentExtra | AIAgentExtra;

export type Database = MergeDeep<
  DatabaseGenerated,
  {
    public: {
      Tables: {
        organizations: {
          Row: {
            extra: OrganizationExtra | null;
          };
          Insert: {
            extra?: OrganizationExtra;
          };
          Update: {
            extra?: OrganizationExtra;
          };
        };
        organizations_addresses: {
          Row: {
            extra: OrganizationAddressExtra | null;
          };
          Insert: {
            extra?: OrganizationAddressExtra;
          };
          Update: {
            extra?: OrganizationAddressExtra;
          };
        };
        conversations: {
          Row: {
            extra: ConversationExtra | null;
          };
          Insert: {
            extra?: ConversationExtra;
          };
          Update: {
            extra?: ConversationExtra;
          };
        };
        messages: {
          Row:
            | {
              direction: "incoming";
              content: IncomingMessage;
              status: IncomingStatus;
            }
            | {
              direction: "internal";
              content: InternalMessage;
              status: IncomingStatus;
            }
            | {
              direction: "outgoing";
              content: OutgoingMessage;
              status: OutgoingStatus;
            };
          Insert:
            | {
              conversation_id?: string;
              direction: "incoming";
              content: IncomingMessage;
              status?: IncomingStatus;
            }
            | {
              conversation_id?: string;
              direction: "internal";
              content: InternalMessage;
              status?: IncomingStatus;
            }
            | {
              conversation_id?: string;
              direction: "outgoing";
              content: OutgoingMessage;
              status?: OutgoingStatus;
            };
        };
        contacts: {
          Row: {
            extra: ContactExtra | null;
          };
          Insert: {
            extra?: ContactExtra;
          };
          Update: {
            extra?: ContactExtra;
          };
        };
        contacts_addresses: {
          Row: {
            extra: ContactAddressExtra | null;
          };
          Insert: {
            extra?: ContactAddressExtra;
          };
          Update: {
            extra?: ContactAddressExtra;
          };
        };
        agents: {
          Row: {
            extra: AgentExtra | null;
          };
          Insert: {
            extra?: AgentExtra;
          };
          Update: {
            extra?: AgentExtra;
          };
        };
        // Declaradas aqui, e não esperando `db_types.ts`, porque a loja de
        // números (tabelas `loja_numeros`/`loja_pedidos` e as funções abaixo)
        // foi desenhada por uma migração escrita em paralelo a este arquivo —
        // mesma razão do bloco de `Functions` do Vault logo adiante, só que
        // para tabelas inteiras em vez de duas colunas. Conferido à mão
        // contra `supabase/schemas/03_models/03-31_loja_numeros.sql`,
        // `03-32_loja_pedidos.sql` e `04_functions_post_tables/04-31_loja.sql`
        // quando escrito — não contra o banco, que ainda não tinha rodado
        // essa migração. Depois que `db_types.ts` for regenerado a partir do
        // schema de verdade, este bloco vira redundante e inofensivo
        // (MergeDeep, mesma forma); se algum dia divergir do gerado, o
        // gerado é quem está certo. - 2026/08/26
        loja_numeros: {
          Row: {
            id: string;
            phone_number_id: string;
            waba_id: string;
            business_id: string | null;
            phone_number: string | null;
            verified_name: string | null;
            preco: number;
            status: string;
            organization_id: string | null;
            criado_em: string;
            atualizado_em: string;
          };
          Insert: {
            id?: string;
            phone_number_id: string;
            waba_id: string;
            business_id?: string | null;
            phone_number?: string | null;
            verified_name?: string | null;
            preco?: number;
            status?: string;
            organization_id?: string | null;
            criado_em?: string;
            atualizado_em?: string;
          };
          Update: {
            id?: string;
            phone_number_id?: string;
            waba_id?: string;
            business_id?: string | null;
            phone_number?: string | null;
            verified_name?: string | null;
            preco?: number;
            status?: string;
            organization_id?: string | null;
            criado_em?: string;
            atualizado_em?: string;
          };
          Relationships: [
            {
              foreignKeyName: "loja_numeros_organization_id_fkey";
              columns: ["organization_id"];
              isOneToOne: false;
              referencedRelation: "organizations";
              referencedColumns: ["id"];
            },
          ];
        };
        loja_pedidos: {
          Row: {
            id: string;
            organization_id: string;
            numero_id: string;
            comprador_user_id: string | null;
            valor: number;
            status: string;
            metodo: string | null;
            codigo_pix: string | null;
            external_id: string | null;
            conectado_por: string | null;
            criado_em: string;
            pago_em: string | null;
            conectado_em: string | null;
          };
          Insert: {
            id?: string;
            organization_id: string;
            numero_id: string;
            comprador_user_id?: string | null;
            valor: number;
            status?: string;
            metodo?: string | null;
            codigo_pix?: string | null;
            external_id?: string | null;
            conectado_por?: string | null;
            criado_em?: string;
            pago_em?: string | null;
            conectado_em?: string | null;
          };
          Update: {
            id?: string;
            organization_id?: string;
            numero_id?: string;
            comprador_user_id?: string | null;
            valor?: number;
            status?: string;
            metodo?: string | null;
            codigo_pix?: string | null;
            external_id?: string | null;
            conectado_por?: string | null;
            criado_em?: string;
            pago_em?: string | null;
            conectado_em?: string | null;
          };
          // `foreignKeyName` é só uma etiqueta para o TypeScript inferir o
          // formato do embed (`organizations(name)`,
          // `loja_numeros(phone_number, verified_name)`) — quem resolve o
          // JOIN de verdade é o PostgREST, olhando a FK real no banco, e não
          // esta string. Errar o nome aqui não quebra a consulta em runtime.
          Relationships: [
            {
              foreignKeyName: "loja_pedidos_organization_id_fkey";
              columns: ["organization_id"];
              isOneToOne: false;
              referencedRelation: "organizations";
              referencedColumns: ["id"];
            },
            {
              foreignKeyName: "loja_pedidos_numero_id_fkey";
              columns: ["numero_id"];
              isOneToOne: false;
              referencedRelation: "loja_numeros";
              referencedColumns: ["id"];
            },
          ];
        };
      };
      // Declared here rather than waiting on `db_types.ts`: these are
      // `service_role`-only Vault accessors added by
      // 20260728055237_whatsapp_token_to_vault. Regenerating `db_types.ts`
      // makes this block redundant but harmless (MergeDeep, same shape).
      //
      // `get_loja_numero_token`/`set_loja_numero_token` foram acrescentadas
      // em 2026/08/26 pelo mesmo motivo, conferidas contra
      // `02_functions/02-05_vault_secrets.sql`.
      Functions: {
        get_whatsapp_access_token: {
          Args: { p_address: string; p_organization_id: string };
          Returns: string | null;
        };
        set_whatsapp_access_token: {
          Args: {
            p_address: string;
            p_organization_id: string;
            p_token: string;
          };
          Returns: undefined;
        };
        delete_whatsapp_access_token: {
          Args: { p_address: string; p_organization_id: string };
          Returns: undefined;
        };
        get_loja_numero_token: {
          Args: { p_numero_id: string };
          Returns: string | null;
        };
        set_loja_numero_token: {
          Args: { p_numero_id: string; p_token: string };
          Returns: undefined;
        };
      };
    };
  }
>;

export type MessageRow = Database["public"]["Tables"]["messages"]["Row"];
export type MessageInsert = Database["public"]["Tables"]["messages"]["Insert"];
export type MessageUpdate = Database["public"]["Tables"]["messages"]["Update"];

export type ConversationRow =
  Database["public"]["Tables"]["conversations"]["Row"];

export type OrganizationRow =
  Database["public"]["Tables"]["organizations"]["Row"];

export type ContactRow = Database["public"]["Tables"]["contacts"]["Row"];
export type ContactInsert = Database["public"]["Tables"]["contacts"]["Insert"];

export type ContactAddressRow =
  Database["public"]["Tables"]["contacts_addresses"]["Row"];
export type ContactAddressInsert =
  Database["public"]["Tables"]["contacts_addresses"]["Insert"];

export type AgentRow = Database["public"]["Tables"]["agents"]["Row"];

export type OrganizationAddressRow =
  Database["public"]["Tables"]["organizations_addresses"]["Row"];

export type ApiKeyRow = Database["public"]["Tables"]["api_keys"]["Row"];
