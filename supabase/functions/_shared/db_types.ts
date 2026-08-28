export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.17"
  }
  billing: {
    Tables: {
      accounts: {
        Row: {
          created_at: string
          email: string | null
          external_id: string | null
          id: string
          name: string
          organization_id: string | null
          provider: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          email?: string | null
          external_id?: string | null
          id?: string
          name: string
          organization_id?: string | null
          provider?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          email?: string | null
          external_id?: string | null
          id?: string
          name?: string
          organization_id?: string | null
          provider?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      costs: {
        Row: {
          created_at: string
          effective_at: string
          pricing: Json
          product: string
          provider: string
          quantity: number
          unit: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          effective_at?: string
          pricing: Json
          product: string
          provider: string
          quantity: number
          unit: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          effective_at?: string
          pricing?: Json
          product?: string
          provider?: string
          quantity?: number
          unit?: string
          updated_at?: string
        }
        Relationships: []
      }
      invoices: {
        Row: {
          created_at: string
          id: string
          organization_id: string
          period_end: string | null
          period_start: string | null
          status: string
          subtotal: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          organization_id: string
          period_end?: string | null
          period_start?: string | null
          status?: string
          subtotal?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          organization_id?: string
          period_end?: string | null
          period_start?: string | null
          status?: string
          subtotal?: number
          updated_at?: string
        }
        Relationships: []
      }
      invoices_items: {
        Row: {
          amount: number
          created_at: string
          id: string
          invoice_id: string
          ledger_id: string | null
          plan_id: string | null
          product_id: string | null
          quantity: number
          type: string
          unit_price: number
          updated_at: string
        }
        Insert: {
          amount: number
          created_at?: string
          id?: string
          invoice_id: string
          ledger_id?: string | null
          plan_id?: string | null
          product_id?: string | null
          quantity: number
          type: string
          unit_price: number
          updated_at?: string
        }
        Update: {
          amount?: number
          created_at?: string
          id?: string
          invoice_id?: string
          ledger_id?: string | null
          plan_id?: string | null
          product_id?: string | null
          quantity?: number
          type?: string
          unit_price?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "invoices_items_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_items_ledger_id_fkey"
            columns: ["ledger_id"]
            isOneToOne: false
            referencedRelation: "ledger"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_items_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "plans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_items_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      ledger: {
        Row: {
          agent_id: string | null
          billable: boolean | null
          created_at: string
          id: string
          message_id: string | null
          metadata: Json | null
          model: string | null
          organization_id: string
          product_id: string
          provider: string | null
          quantity: number
          type: string
          updated_at: string
        }
        Insert: {
          agent_id?: string | null
          billable?: boolean | null
          created_at?: string
          id?: string
          message_id?: string | null
          metadata?: Json | null
          model?: string | null
          organization_id: string
          product_id: string
          provider?: string | null
          quantity: number
          type: string
          updated_at?: string
        }
        Update: {
          agent_id?: string | null
          billable?: boolean | null
          created_at?: string
          id?: string
          message_id?: string | null
          metadata?: Json | null
          model?: string | null
          organization_id?: string
          product_id?: string
          provider?: string | null
          quantity?: number
          type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ledger_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      payments: {
        Row: {
          account_id: string | null
          amount: number
          created_at: string
          external_id: string | null
          id: string
          invoice_id: string
          method: string | null
          organization_id: string
          status: string
          updated_at: string
        }
        Insert: {
          account_id?: string | null
          amount: number
          created_at?: string
          external_id?: string | null
          id?: string
          invoice_id: string
          method?: string | null
          organization_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          account_id?: string | null
          amount?: number
          created_at?: string
          external_id?: string | null
          id?: string
          invoice_id?: string
          method?: string | null
          organization_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "payments_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
        ]
      }
      plans: {
        Row: {
          active: boolean
          billing_cycle: string | null
          created_at: string
          id: string
          is_default: boolean
          min_tier: number
          price: number
          updated_at: string
        }
        Insert: {
          active?: boolean
          billing_cycle?: string | null
          created_at?: string
          id: string
          is_default?: boolean
          min_tier: number
          price: number
          updated_at?: string
        }
        Update: {
          active?: boolean
          billing_cycle?: string | null
          created_at?: string
          id?: string
          is_default?: boolean
          min_tier?: number
          price?: number
          updated_at?: string
        }
        Relationships: []
      }
      plans_products: {
        Row: {
          created_at: string
          included: number | null
          interval: string
          plan_id: string
          product_id: string
          unit_price: number | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          included?: number | null
          interval: string
          plan_id: string
          product_id: string
          unit_price?: number | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          included?: number | null
          interval?: string
          plan_id?: string
          product_id?: string
          unit_price?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "plans_products_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "plans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "plans_products_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      products: {
        Row: {
          created_at: string
          id: string
          kind: string
          name: string
          unit: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id: string
          kind: string
          name: string
          unit: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          kind?: string
          name?: string
          unit?: string
          updated_at?: string
        }
        Relationships: []
      }
      subscriptions: {
        Row: {
          account_id: string | null
          created_at: string
          current_period_end: string | null
          current_period_start: string | null
          organization_id: string
          plan_id: string | null
          tier_id: string
          trial_ends_at: string | null
          updated_at: string
        }
        Insert: {
          account_id?: string | null
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          organization_id: string
          plan_id?: string | null
          tier_id: string
          trial_ends_at?: string | null
          updated_at?: string
        }
        Update: {
          account_id?: string | null
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          organization_id?: string
          plan_id?: string | null
          tier_id?: string
          trial_ends_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "subscriptions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "subscriptions_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "plans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "subscriptions_tier_id_fkey"
            columns: ["tier_id"]
            isOneToOne: false
            referencedRelation: "tiers"
            referencedColumns: ["id"]
          },
        ]
      }
      tiers: {
        Row: {
          active: boolean
          created_at: string
          id: string
          level: number
          name: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          id: string
          level?: number
          name: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          id?: string
          level?: number
          name?: string
          updated_at?: string
        }
        Relationships: []
      }
      tiers_products: {
        Row: {
          cap: number | null
          created_at: string
          interval: string
          product_id: string
          tier_id: string
          updated_at: string
        }
        Insert: {
          cap?: number | null
          created_at?: string
          interval: string
          product_id: string
          tier_id: string
          updated_at?: string
        }
        Update: {
          cap?: number | null
          created_at?: string
          interval?: string
          product_id?: string
          tier_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tiers_products_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tiers_products_tier_id_fkey"
            columns: ["tier_id"]
            isOneToOne: false
            referencedRelation: "tiers"
            referencedColumns: ["id"]
          },
        ]
      }
      usage: {
        Row: {
          created_at: string
          interval: string
          organization_id: string
          period: string
          product_id: string
          quantity: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          interval?: string
          organization_id: string
          period?: string
          product_id: string
          quantity?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          interval?: string
          organization_id?: string
          period?: string
          product_id?: string
          quantity?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "usage_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      change_plan: {
        Args: { _organization_id: string; _plan_id: string }
        Returns: undefined
      }
      check_limit: {
        Args: {
          _amount?: number
          _organization_id: string
          _product_id: string
        }
        Returns: boolean
      }
      emitir_fatura: {
        Args: { _organization_id: string; _quando?: string }
        Returns: string
      }
      emitir_faturas_do_mes: { Args: { _quando?: string }; Returns: number }
      registrar_pagamento: {
        Args: {
          _account_id?: string
          _amount: number
          _external_id?: string
          _invoice_id: string
          _method: string
        }
        Returns: string
      }
      update_usage: {
        Args: {
          _organization_id: string
          _product_id: string
          _quantity?: number
        }
        Returns: undefined
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      agents: {
        Row: {
          ai: boolean
          created_at: string
          extra: Json | null
          id: string
          name: string
          organization_id: string
          picture: string | null
          updated_at: string
          user_id: string | null
        }
        Insert: {
          ai: boolean
          created_at?: string
          extra?: Json | null
          id?: string
          name: string
          organization_id: string
          picture?: string | null
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          ai?: boolean
          created_at?: string
          extra?: Json | null
          id?: string
          name?: string
          organization_id?: string
          picture?: string | null
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "agents_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      api_keys: {
        Row: {
          created_at: string
          id: string
          key_hash: string
          name: string
          organization_id: string
          role: Database["public"]["Enums"]["role"]
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          key_hash: string
          name: string
          organization_id: string
          role?: Database["public"]["Enums"]["role"]
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          key_hash?: string
          name?: string
          organization_id?: string
          role?: Database["public"]["Enums"]["role"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "api_keys_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      appointments: {
        Row: {
          contact_address: string
          conversation_id: string | null
          created_at: string
          deposit: number | null
          duration_minutes: number | null
          external_id: string | null
          extra: Json
          id: string
          notes: string | null
          organization_address: string
          organization_id: string
          price: number | null
          professional_id: string | null
          service: Database["public"]["Enums"]["service"]
          starts_at: string
          status: Database["public"]["Enums"]["appointment_status"]
          title: string
          updated_at: string
        }
        Insert: {
          contact_address: string
          conversation_id?: string | null
          created_at?: string
          deposit?: number | null
          duration_minutes?: number | null
          external_id?: string | null
          extra?: Json
          id?: string
          notes?: string | null
          organization_address: string
          organization_id: string
          price?: number | null
          professional_id?: string | null
          service: Database["public"]["Enums"]["service"]
          starts_at: string
          status?: Database["public"]["Enums"]["appointment_status"]
          title: string
          updated_at?: string
        }
        Update: {
          contact_address?: string
          conversation_id?: string | null
          created_at?: string
          deposit?: number | null
          duration_minutes?: number | null
          external_id?: string | null
          extra?: Json
          id?: string
          notes?: string | null
          organization_address?: string
          organization_id?: string
          price?: number | null
          professional_id?: string | null
          service?: Database["public"]["Enums"]["service"]
          starts_at?: string
          status?: Database["public"]["Enums"]["appointment_status"]
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "appointments_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointments_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointments_professional_id_fkey"
            columns: ["professional_id"]
            isOneToOne: false
            referencedRelation: "professionals"
            referencedColumns: ["id"]
          },
        ]
      }
      campaigns: {
        Row: {
          audience: Json
          completed_at: string | null
          created_at: string
          created_by: string | null
          extra: Json
          id: string
          name: string
          organization_address: string
          organization_id: string
          scheduled_at: string | null
          service: Database["public"]["Enums"]["service"]
          started_at: string | null
          status: Database["public"]["Enums"]["campaign_status"]
          template_category: string
          template_language: string
          template_name: string
          throughput_mps: number
          updated_at: string
          variables: Json
        }
        Insert: {
          audience?: Json
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          extra?: Json
          id?: string
          name: string
          organization_address: string
          organization_id: string
          scheduled_at?: string | null
          service?: Database["public"]["Enums"]["service"]
          started_at?: string | null
          status?: Database["public"]["Enums"]["campaign_status"]
          template_category: string
          template_language: string
          template_name: string
          throughput_mps?: number
          updated_at?: string
          variables?: Json
        }
        Update: {
          audience?: Json
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          extra?: Json
          id?: string
          name?: string
          organization_address?: string
          organization_id?: string
          scheduled_at?: string | null
          service?: Database["public"]["Enums"]["service"]
          started_at?: string | null
          status?: Database["public"]["Enums"]["campaign_status"]
          template_category?: string
          template_language?: string
          template_name?: string
          throughput_mps?: number
          updated_at?: string
          variables?: Json
        }
        Relationships: [
          {
            foreignKeyName: "campaigns_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      cobranca_recebimentos: {
        Row: {
          agent_id: string | null
          cobranca_id: string
          conta: string | null
          created_at: string
          id: string
          metodo: string | null
          nota: string | null
          organization_id: string
          recebido_em: string
          valor: number
        }
        Insert: {
          agent_id?: string | null
          cobranca_id: string
          conta?: string | null
          created_at?: string
          id?: string
          metodo?: string | null
          nota?: string | null
          organization_id: string
          recebido_em?: string
          valor: number
        }
        Update: {
          agent_id?: string | null
          cobranca_id?: string
          conta?: string | null
          created_at?: string
          id?: string
          metodo?: string | null
          nota?: string | null
          organization_id?: string
          recebido_em?: string
          valor?: number
        }
        Relationships: [
          {
            foreignKeyName: "cobranca_recebimentos_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cobranca_recebimentos_cobranca_id_fkey"
            columns: ["cobranca_id"]
            isOneToOne: false
            referencedRelation: "cobrancas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cobranca_recebimentos_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      cobrancas: {
        Row: {
          agent_id: string | null
          codigo_pix: string | null
          combinado_para: string | null
          conta: string | null
          contact_address: string
          conversation_id: string
          created_at: string
          expira_em: string | null
          external_id: string | null
          id: string
          itens: Json
          metodo: string | null
          nota: string | null
          organization_id: string
          paga_em: string | null
          recibo_em: string | null
          status: string
          updated_at: string
          validade_dias: number | null
          valor: number
          valor_pago: number
          vence_em: string | null
        }
        Insert: {
          agent_id?: string | null
          codigo_pix?: string | null
          combinado_para?: string | null
          conta?: string | null
          contact_address: string
          conversation_id: string
          created_at?: string
          expira_em?: string | null
          external_id?: string | null
          id?: string
          itens?: Json
          metodo?: string | null
          nota?: string | null
          organization_id: string
          paga_em?: string | null
          recibo_em?: string | null
          status?: string
          updated_at?: string
          validade_dias?: number | null
          valor: number
          valor_pago?: number
          vence_em?: string | null
        }
        Update: {
          agent_id?: string | null
          codigo_pix?: string | null
          combinado_para?: string | null
          conta?: string | null
          contact_address?: string
          conversation_id?: string
          created_at?: string
          expira_em?: string | null
          external_id?: string | null
          id?: string
          itens?: Json
          metodo?: string | null
          nota?: string | null
          organization_id?: string
          paga_em?: string | null
          recibo_em?: string | null
          status?: string
          updated_at?: string
          validade_dias?: number | null
          valor?: number
          valor_pago?: number
          vence_em?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "cobrancas_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cobrancas_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cobrancas_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      comissoes: {
        Row: {
          agent_id: string
          criado_em: string
          estornado_em: string | null
          id: string
          negocio_id: string
          organization_id: string
          status: string
          tipo: string
          valor: number
        }
        Insert: {
          agent_id: string
          criado_em?: string
          estornado_em?: string | null
          id?: string
          negocio_id: string
          organization_id: string
          status?: string
          tipo?: string
          valor: number
        }
        Update: {
          agent_id?: string
          criado_em?: string
          estornado_em?: string | null
          id?: string
          negocio_id?: string
          organization_id?: string
          status?: string
          tipo?: string
          valor?: number
        }
        Relationships: [
          {
            foreignKeyName: "comissoes_negocio_id_fkey"
            columns: ["negocio_id"]
            isOneToOne: false
            referencedRelation: "negocios"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comissoes_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      contacts: {
        Row: {
          created_at: string
          extra: Json | null
          id: string
          name: string | null
          organization_id: string
          status: string
          tags: string[]
          updated_at: string
        }
        Insert: {
          created_at?: string
          extra?: Json | null
          id?: string
          name?: string | null
          organization_id: string
          status?: string
          tags?: string[]
          updated_at?: string
        }
        Update: {
          created_at?: string
          extra?: Json | null
          id?: string
          name?: string | null
          organization_id?: string
          status?: string
          tags?: string[]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "contacts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      contacts_addresses: {
        Row: {
          address: string
          contact_id: string | null
          created_at: string
          extra: Json | null
          marketing_opt_in_at: string | null
          marketing_opt_in_origem: string | null
          marketing_opt_out_at: string | null
          organization_id: string
          service: Database["public"]["Enums"]["service"]
          status: string
          updated_at: string
        }
        Insert: {
          address: string
          contact_id?: string | null
          created_at?: string
          extra?: Json | null
          marketing_opt_in_at?: string | null
          marketing_opt_in_origem?: string | null
          marketing_opt_out_at?: string | null
          organization_id: string
          service: Database["public"]["Enums"]["service"]
          status?: string
          updated_at?: string
        }
        Update: {
          address?: string
          contact_id?: string | null
          created_at?: string
          extra?: Json | null
          marketing_opt_in_at?: string | null
          marketing_opt_in_origem?: string | null
          marketing_opt_out_at?: string | null
          organization_id?: string
          service?: Database["public"]["Enums"]["service"]
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "contacts_addresses_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contact_overview"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contacts_addresses_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contacts_addresses_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      conversations: {
        Row: {
          contact_address: string | null
          created_at: string
          extra: Json | null
          group_address: string | null
          id: string
          name: string | null
          organization_address: string
          organization_id: string
          service: Database["public"]["Enums"]["service"]
          status: string
          updated_at: string
        }
        Insert: {
          contact_address?: string | null
          created_at?: string
          extra?: Json | null
          group_address?: string | null
          id?: string
          name?: string | null
          organization_address: string
          organization_id: string
          service: Database["public"]["Enums"]["service"]
          status?: string
          updated_at?: string
        }
        Update: {
          contact_address?: string | null
          created_at?: string
          extra?: Json | null
          group_address?: string | null
          id?: string
          name?: string | null
          organization_address?: string
          organization_id?: string
          service?: Database["public"]["Enums"]["service"]
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversations_contact_address_fkey"
            columns: ["organization_id", "service", "contact_address"]
            isOneToOne: false
            referencedRelation: "contacts_addresses"
            referencedColumns: ["organization_id", "service", "address"]
          },
          {
            foreignKeyName: "conversations_organization_address_fkey"
            columns: ["organization_id", "organization_address"]
            isOneToOne: false
            referencedRelation: "organizations_addresses"
            referencedColumns: ["organization_id", "address"]
          },
          {
            foreignKeyName: "conversations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      gateway_credenciais: {
        Row: {
          ativo: boolean
          atualizado_em: string
          chave_publica: string | null
          chave_secreta: string
          criado_em: string
          organization_id: string
          provedor: string
          segredo_webhook: string | null
        }
        Insert: {
          ativo?: boolean
          atualizado_em?: string
          chave_publica?: string | null
          chave_secreta: string
          criado_em?: string
          organization_id: string
          provedor?: string
          segredo_webhook?: string | null
        }
        Update: {
          ativo?: boolean
          atualizado_em?: string
          chave_publica?: string | null
          chave_secreta?: string
          criado_em?: string
          organization_id?: string
          provedor?: string
          segredo_webhook?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "gateway_credenciais_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: true
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      iptv_apps: {
        Row: {
          app: string
          codigo: string | null
          created_at: string
          display_name: string | null
          favorito: boolean
          id: string
          is_enabled: boolean
          ordem: number
          pacote_id: string
          texto: string | null
          updated_at: string
        }
        Insert: {
          app: string
          codigo?: string | null
          created_at?: string
          display_name?: string | null
          favorito?: boolean
          id?: string
          is_enabled?: boolean
          ordem?: number
          pacote_id: string
          texto?: string | null
          updated_at?: string
        }
        Update: {
          app?: string
          codigo?: string | null
          created_at?: string
          display_name?: string | null
          favorito?: boolean
          id?: string
          is_enabled?: boolean
          ordem?: number
          pacote_id?: string
          texto?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "iptv_apps_pacote_id_fkey"
            columns: ["pacote_id"]
            isOneToOne: false
            referencedRelation: "iptv_pacotes"
            referencedColumns: ["id"]
          },
        ]
      }
      iptv_pacotes: {
        Row: {
          bot_path: string | null
          bot_url: string | null
          created_at: string
          creditos: number | null
          descricao: string | null
          duracao_horas: number | null
          id: string
          is_active: boolean
          name: string
          painel_pacote_id: string | null
          preco: number | null
          preco_tela_extra: number | null
          renova_sozinho: boolean
          servidor_id: string
          telas: number
          tipo: string
          updated_at: string
        }
        Insert: {
          bot_path?: string | null
          bot_url?: string | null
          created_at?: string
          creditos?: number | null
          descricao?: string | null
          duracao_horas?: number | null
          id?: string
          is_active?: boolean
          name: string
          painel_pacote_id?: string | null
          preco?: number | null
          preco_tela_extra?: number | null
          renova_sozinho?: boolean
          servidor_id: string
          telas?: number
          tipo?: string
          updated_at?: string
        }
        Update: {
          bot_path?: string | null
          bot_url?: string | null
          created_at?: string
          creditos?: number | null
          descricao?: string | null
          duracao_horas?: number | null
          id?: string
          is_active?: boolean
          name?: string
          painel_pacote_id?: string | null
          preco?: number | null
          preco_tela_extra?: number | null
          renova_sozinho?: boolean
          servidor_id?: string
          telas?: number
          tipo?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "iptv_pacotes_servidor_id_fkey"
            columns: ["servidor_id"]
            isOneToOne: false
            referencedRelation: "iptv_servidores"
            referencedColumns: ["id"]
          },
        ]
      }
      iptv_servidores: {
        Row: {
          base_url: string | null
          created_at: string
          id: string
          is_active: boolean
          name: string
          organization_id: string
          painel_url: string | null
          painel_user_id: string | null
          slug: string
          trial_horas: number
          updated_at: string
        }
        Insert: {
          base_url?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          name: string
          organization_id: string
          painel_url?: string | null
          painel_user_id?: string | null
          slug: string
          trial_horas?: number
          updated_at?: string
        }
        Update: {
          base_url?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          name?: string
          organization_id?: string
          painel_url?: string | null
          painel_user_id?: string | null
          slug?: string
          trial_horas?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "iptv_servidores_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      iptv_testes: {
        Row: {
          app: string | null
          apps: Json | null
          cobranca_id: string | null
          codigo: string | null
          comeca_em: string
          contact_address: string
          contact_id: string | null
          conversation_id: string | null
          convertido_em: string | null
          created_at: string
          dns: string | null
          duracao_horas: number
          expira_em: string
          id: string
          m3u_url: string | null
          motivo_perda: string | null
          organization_id: string
          pacote_id: string | null
          pacote_nome: string | null
          pacote_vendido_id: string | null
          password: string | null
          servidor_id: string | null
          servidor_nome: string | null
          status: string
          updated_at: string
          username: string
          vendido_por: string | null
        }
        Insert: {
          app?: string | null
          apps?: Json | null
          cobranca_id?: string | null
          codigo?: string | null
          comeca_em?: string
          contact_address: string
          contact_id?: string | null
          conversation_id?: string | null
          convertido_em?: string | null
          created_at?: string
          dns?: string | null
          duracao_horas?: number
          expira_em: string
          id?: string
          m3u_url?: string | null
          motivo_perda?: string | null
          organization_id: string
          pacote_id?: string | null
          pacote_nome?: string | null
          pacote_vendido_id?: string | null
          password?: string | null
          servidor_id?: string | null
          servidor_nome?: string | null
          status?: string
          updated_at?: string
          username: string
          vendido_por?: string | null
        }
        Update: {
          app?: string | null
          apps?: Json | null
          cobranca_id?: string | null
          codigo?: string | null
          comeca_em?: string
          contact_address?: string
          contact_id?: string | null
          conversation_id?: string | null
          convertido_em?: string | null
          created_at?: string
          dns?: string | null
          duracao_horas?: number
          expira_em?: string
          id?: string
          m3u_url?: string | null
          motivo_perda?: string | null
          organization_id?: string
          pacote_id?: string | null
          pacote_nome?: string | null
          pacote_vendido_id?: string | null
          password?: string | null
          servidor_id?: string | null
          servidor_nome?: string | null
          status?: string
          updated_at?: string
          username?: string
          vendido_por?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "iptv_testes_cobranca_id_fkey"
            columns: ["cobranca_id"]
            isOneToOne: false
            referencedRelation: "cobrancas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "iptv_testes_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contact_overview"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "iptv_testes_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "iptv_testes_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "iptv_testes_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "iptv_testes_pacote_vendido_id_fkey"
            columns: ["pacote_vendido_id"]
            isOneToOne: false
            referencedRelation: "iptv_pacotes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "iptv_testes_vendido_por_fkey"
            columns: ["vendido_por"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
        ]
      }
      logs: {
        Row: {
          category: string
          created_at: string
          id: string
          level: Database["public"]["Enums"]["log_level"]
          message: string
          metadata: Json | null
          organization_address: string | null
          organization_id: string
          service: Database["public"]["Enums"]["service"] | null
        }
        Insert: {
          category: string
          created_at?: string
          id?: string
          level: Database["public"]["Enums"]["log_level"]
          message: string
          metadata?: Json | null
          organization_address?: string | null
          organization_id: string
          service?: Database["public"]["Enums"]["service"] | null
        }
        Update: {
          category?: string
          created_at?: string
          id?: string
          level?: Database["public"]["Enums"]["log_level"]
          message?: string
          metadata?: Json | null
          organization_address?: string | null
          organization_id?: string
          service?: Database["public"]["Enums"]["service"] | null
        }
        Relationships: [
          {
            foreignKeyName: "logs_organization_address_fkey"
            columns: ["organization_id", "organization_address"]
            isOneToOne: false
            referencedRelation: "organizations_addresses"
            referencedColumns: ["organization_id", "address"]
          },
          {
            foreignKeyName: "logs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      loja_numeros: {
        Row: {
          atualizado_em: string
          business_id: string | null
          criado_em: string
          id: string
          organization_id: string | null
          phone_number: string | null
          phone_number_id: string
          preco: number
          status: string
          verified_name: string | null
          waba_id: string
        }
        Insert: {
          atualizado_em?: string
          business_id?: string | null
          criado_em?: string
          id?: string
          organization_id?: string | null
          phone_number?: string | null
          phone_number_id: string
          preco?: number
          status?: string
          verified_name?: string | null
          waba_id: string
        }
        Update: {
          atualizado_em?: string
          business_id?: string | null
          criado_em?: string
          id?: string
          organization_id?: string | null
          phone_number?: string | null
          phone_number_id?: string
          preco?: number
          status?: string
          verified_name?: string | null
          waba_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "loja_numeros_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      loja_pedidos: {
        Row: {
          codigo_pix: string | null
          comprador_user_id: string | null
          conectado_em: string | null
          conectado_por: string | null
          criado_em: string
          external_id: string | null
          id: string
          metodo: string | null
          numero_id: string
          organization_id: string
          pago_em: string | null
          status: string
          valor: number
        }
        Insert: {
          codigo_pix?: string | null
          comprador_user_id?: string | null
          conectado_em?: string | null
          conectado_por?: string | null
          criado_em?: string
          external_id?: string | null
          id?: string
          metodo?: string | null
          numero_id: string
          organization_id: string
          pago_em?: string | null
          status?: string
          valor: number
        }
        Update: {
          codigo_pix?: string | null
          comprador_user_id?: string | null
          conectado_em?: string | null
          conectado_por?: string | null
          criado_em?: string
          external_id?: string | null
          id?: string
          metodo?: string | null
          numero_id?: string
          organization_id?: string
          pago_em?: string | null
          status?: string
          valor?: number
        }
        Relationships: [
          {
            foreignKeyName: "loja_pedidos_numero_id_fkey"
            columns: ["numero_id"]
            isOneToOne: false
            referencedRelation: "loja_numeros"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loja_pedidos_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      messages: {
        Row: {
          agent_id: string | null
          campaign_id: string | null
          contact_address: string | null
          content: Json
          conversation_id: string
          created_at: string
          direction: Database["public"]["Enums"]["direction"]
          external_id: string | null
          group_address: string | null
          id: string
          organization_address: string
          organization_id: string
          service: Database["public"]["Enums"]["service"]
          status: Json
          thread_id: string | null
          timestamp: string
          updated_at: string
        }
        Insert: {
          agent_id?: string | null
          campaign_id?: string | null
          contact_address?: string | null
          content: Json
          conversation_id: string
          created_at?: string
          direction: Database["public"]["Enums"]["direction"]
          external_id?: string | null
          group_address?: string | null
          id?: string
          organization_address: string
          organization_id: string
          service: Database["public"]["Enums"]["service"]
          status?: Json
          thread_id?: string | null
          timestamp?: string
          updated_at?: string
        }
        Update: {
          agent_id?: string | null
          campaign_id?: string | null
          contact_address?: string | null
          content?: Json
          conversation_id?: string
          created_at?: string
          direction?: Database["public"]["Enums"]["direction"]
          external_id?: string | null
          group_address?: string | null
          id?: string
          organization_address?: string
          organization_id?: string
          service?: Database["public"]["Enums"]["service"]
          status?: Json
          thread_id?: string | null
          timestamp?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "messages_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      negocios: {
        Row: {
          abertura_sugerida: string | null
          atualizado_em: string
          categoria: string | null
          cidade: string | null
          cidade_normalizada: string | null
          conversation_id: string | null
          criado_em: string
          dores_identificadas: Json | null
          estado_normalizado: string | null
          estagio: string
          externo_id: string | null
          extra: Json | null
          id: string
          motivo_ia: string | null
          motivo_perda: string | null
          nicho: string | null
          nome: string
          organization_id: string
          origem: string
          origem_localizacao: string | null
          responsavel_id: string | null
          reuniao_em: string | null
          score_ia: number | null
          telefone: string | null
          valor_estimado: number | null
          veredito_ia: string | null
        }
        Insert: {
          abertura_sugerida?: string | null
          atualizado_em?: string
          categoria?: string | null
          cidade?: string | null
          cidade_normalizada?: string | null
          conversation_id?: string | null
          criado_em?: string
          dores_identificadas?: Json | null
          estado_normalizado?: string | null
          estagio?: string
          externo_id?: string | null
          extra?: Json | null
          id?: string
          motivo_ia?: string | null
          motivo_perda?: string | null
          nicho?: string | null
          nome: string
          organization_id: string
          origem?: string
          origem_localizacao?: string | null
          responsavel_id?: string | null
          reuniao_em?: string | null
          score_ia?: number | null
          telefone?: string | null
          valor_estimado?: number | null
          veredito_ia?: string | null
        }
        Update: {
          abertura_sugerida?: string | null
          atualizado_em?: string
          categoria?: string | null
          cidade?: string | null
          cidade_normalizada?: string | null
          conversation_id?: string | null
          criado_em?: string
          dores_identificadas?: Json | null
          estado_normalizado?: string | null
          estagio?: string
          externo_id?: string | null
          extra?: Json | null
          id?: string
          motivo_ia?: string | null
          motivo_perda?: string | null
          nicho?: string | null
          nome?: string
          organization_id?: string
          origem?: string
          origem_localizacao?: string | null
          responsavel_id?: string | null
          reuniao_em?: string | null
          score_ia?: number | null
          telefone?: string | null
          valor_estimado?: number | null
          veredito_ia?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "negocios_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      onboarding_tokens: {
        Row: {
          callback_url: string | null
          created_at: string
          expires_at: string
          id: string
          name: string
          organization_id: string
          service: Database["public"]["Enums"]["service"]
          status: string
          used_at: string | null
          verify_token: string | null
        }
        Insert: {
          callback_url?: string | null
          created_at?: string
          expires_at: string
          id?: string
          name: string
          organization_id: string
          service: Database["public"]["Enums"]["service"]
          status?: string
          used_at?: string | null
          verify_token?: string | null
        }
        Update: {
          callback_url?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          name?: string
          organization_id?: string
          service?: Database["public"]["Enums"]["service"]
          status?: string
          used_at?: string | null
          verify_token?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "onboarding_tokens_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          created_at: string
          extra: Json | null
          id: string
          name: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          extra?: Json | null
          id?: string
          name: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          extra?: Json | null
          id?: string
          name?: string
          updated_at?: string
        }
        Relationships: []
      }
      organizations_addresses: {
        Row: {
          address: string
          created_at: string
          extra: Json | null
          organization_id: string
          service: Database["public"]["Enums"]["service"]
          status: string
          updated_at: string
        }
        Insert: {
          address: string
          created_at?: string
          extra?: Json | null
          organization_id: string
          service: Database["public"]["Enums"]["service"]
          status?: string
          updated_at?: string
        }
        Update: {
          address?: string
          created_at?: string
          extra?: Json | null
          organization_id?: string
          service?: Database["public"]["Enums"]["service"]
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "organizations_addresses_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      professionals: {
        Row: {
          active: boolean
          created_at: string
          extra: Json
          id: string
          name: string
          organization_id: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          extra?: Json
          id?: string
          name: string
          organization_id: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          extra?: Json
          id?: string
          name?: string
          organization_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "professionals_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      push_subscriptions: {
        Row: {
          auth: string
          created_at: string
          endpoint: string
          extra: Json
          id: string
          organization_id: string
          p256dh: string
          updated_at: string
          user_agent: string | null
          user_id: string
        }
        Insert: {
          auth: string
          created_at?: string
          endpoint: string
          extra?: Json
          id?: string
          organization_id: string
          p256dh: string
          updated_at?: string
          user_agent?: string | null
          user_id: string
        }
        Update: {
          auth?: string
          created_at?: string
          endpoint?: string
          extra?: Json
          id?: string
          organization_id?: string
          p256dh?: string
          updated_at?: string
          user_agent?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "push_subscriptions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      quick_replies: {
        Row: {
          content: string
          created_at: string
          id: string
          name: string
          organization_id: string
          updated_at: string
        }
        Insert: {
          content: string
          created_at?: string
          id?: string
          name: string
          organization_id: string
          updated_at?: string
        }
        Update: {
          content?: string
          created_at?: string
          id?: string
          name?: string
          organization_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "quick_replies_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      time_off: {
        Row: {
          created_at: string
          ends_at: string
          extra: Json
          id: string
          organization_id: string
          professional_id: string | null
          reason: string | null
          starts_at: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          ends_at: string
          extra?: Json
          id?: string
          organization_id: string
          professional_id?: string | null
          reason?: string | null
          starts_at: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          ends_at?: string
          extra?: Json
          id?: string
          organization_id?: string
          professional_id?: string | null
          reason?: string | null
          starts_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "time_off_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "time_off_professional_id_fkey"
            columns: ["professional_id"]
            isOneToOne: false
            referencedRelation: "professionals"
            referencedColumns: ["id"]
          },
        ]
      }
      waitlist: {
        Row: {
          contact_address: string
          conversation_id: string
          created_at: string
          desired_date: string | null
          desired_period: string | null
          extra: Json
          id: string
          offered_at: string | null
          offered_for: string | null
          organization_address: string
          organization_id: string
          professional_id: string | null
          service: Database["public"]["Enums"]["service"]
          status: Database["public"]["Enums"]["waitlist_status"]
          title: string | null
          updated_at: string
        }
        Insert: {
          contact_address: string
          conversation_id: string
          created_at?: string
          desired_date?: string | null
          desired_period?: string | null
          extra?: Json
          id?: string
          offered_at?: string | null
          offered_for?: string | null
          organization_address: string
          organization_id: string
          professional_id?: string | null
          service: Database["public"]["Enums"]["service"]
          status?: Database["public"]["Enums"]["waitlist_status"]
          title?: string | null
          updated_at?: string
        }
        Update: {
          contact_address?: string
          conversation_id?: string
          created_at?: string
          desired_date?: string | null
          desired_period?: string | null
          extra?: Json
          id?: string
          offered_at?: string | null
          offered_for?: string | null
          organization_address?: string
          organization_id?: string
          professional_id?: string | null
          service?: Database["public"]["Enums"]["service"]
          status?: Database["public"]["Enums"]["waitlist_status"]
          title?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "waitlist_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "waitlist_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "waitlist_professional_id_fkey"
            columns: ["professional_id"]
            isOneToOne: false
            referencedRelation: "professionals"
            referencedColumns: ["id"]
          },
        ]
      }
      webhooks: {
        Row: {
          created_at: string
          id: string
          operations: Database["public"]["Enums"]["webhook_operation"][]
          organization_id: string
          table_name: Database["public"]["Enums"]["webhook_table"]
          token: string | null
          updated_at: string
          url: string
        }
        Insert: {
          created_at?: string
          id?: string
          operations: Database["public"]["Enums"]["webhook_operation"][]
          organization_id: string
          table_name: Database["public"]["Enums"]["webhook_table"]
          token?: string | null
          updated_at?: string
          url: string
        }
        Update: {
          created_at?: string
          id?: string
          operations?: Database["public"]["Enums"]["webhook_operation"][]
          organization_id?: string
          table_name?: Database["public"]["Enums"]["webhook_table"]
          token?: string | null
          updated_at?: string
          url?: string
        }
        Relationships: [
          {
            foreignKeyName: "webhooks_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      contact_overview: {
        Row: {
          agendou: boolean | null
          anuncio_clique: string | null
          anuncio_id: string | null
          anuncio_tipo: string | null
          anuncio_titulo: string | null
          assina_ate: string | null
          assina_desde: string | null
          assinante: boolean | null
          atendidos: number | null
          ciclo_dias: number | null
          cobrancas_abertas: number | null
          cobrancas_pagas: number | null
          compromissos: number | null
          compromissos_marcados: number | null
          conversas: number | null
          created_at: string | null
          deve: boolean | null
          enviadas: number | null
          faltas: number | null
          fiado: number | null
          gasto: number | null
          id: string | null
          ja_pagou_cobranca: boolean | null
          metodo_assinatura: string | null
          name: string | null
          organization_id: string | null
          pagamentos: number | null
          pagou: boolean | null
          plano_nome: string | null
          plano_valor: number | null
          primeira_mensagem: string | null
          recebidas: number | null
          sem_resposta: boolean | null
          status: string | null
          tags: string[] | null
          tem_cobranca_aberta: boolean | null
          total_aberto: number | null
          total_pago: number | null
          ultima_mensagem: string | null
          ultimo_horario: string | null
          veio_de_anuncio: boolean | null
          veio_em: string | null
        }
        Relationships: [
          {
            foreignKeyName: "contacts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      agent_update_by_owner_rules: {
        Args: {
          p_ai: boolean
          p_extra: Json
          p_id: string
          p_organization_id: string
          p_user_id: string
        }
        Returns: boolean
      }
      campaign_recipients: {
        Args: { p_campaign: Database["public"]["Tables"]["campaigns"]["Row"] }
        Returns: {
          contact_address: string
          content: Json
          conversation_id: string
        }[]
      }
      cancel_scheduled_message: {
        Args: { p_message_id: string }
        Returns: undefined
      }
      cancelar_pedido_loja: { Args: { _pedido: string }; Returns: undefined }
      claim_pending_messages: {
        Args: { p_budget_per_address?: number }
        Returns: {
          agent_id: string | null
          campaign_id: string | null
          contact_address: string | null
          content: Json
          conversation_id: string
          created_at: string
          direction: Database["public"]["Enums"]["direction"]
          external_id: string | null
          group_address: string | null
          id: string
          organization_address: string
          organization_id: string
          service: Database["public"]["Enums"]["service"]
          status: Json
          thread_id: string | null
          timestamp: string
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "messages"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      complete_finished_campaigns: { Args: never; Returns: number }
      contact_address_update_rules: {
        Args: {
          p_address: string
          p_extra: Json
          p_organization_id: string
          p_service: Database["public"]["Enums"]["service"]
          p_status: string
        }
        Returns: boolean
      }
      contacts_needing_memory: {
        Args: { p_limit?: number }
        Returns: {
          contact_id: string
          conversation_id: string
          messages_since: number
          organization_id: string
        }[]
      }
      count_audience: {
        Args: {
          p_audience: Json
          p_organization_address: string
          p_organization_id: string
          p_template_category: string
        }
        Returns: number
      }
      count_campaign_audience: {
        Args: { p_campaign_id: string }
        Returns: number
      }
      create_api_key: {
        Args: {
          p_name: string
          p_organization_id: string
          p_role?: Database["public"]["Enums"]["role"]
        }
        Returns: {
          api_key: string
          api_key_id: string
        }[]
      }
      delete_campaign: { Args: { p_campaign_id: string }; Returns: number }
      delete_whatsapp_access_token: {
        Args: { p_address: string; p_organization_id: string }
        Returns: undefined
      }
      desmarcar_reuniao_negocio: {
        Args: { _negocio: string }
        Returns: {
          abertura_sugerida: string | null
          atualizado_em: string
          categoria: string | null
          cidade: string | null
          cidade_normalizada: string | null
          conversation_id: string | null
          criado_em: string
          dores_identificadas: Json | null
          estado_normalizado: string | null
          estagio: string
          externo_id: string | null
          extra: Json | null
          id: string
          motivo_ia: string | null
          motivo_perda: string | null
          nicho: string | null
          nome: string
          organization_id: string
          origem: string
          origem_localizacao: string | null
          responsavel_id: string | null
          reuniao_em: string | null
          score_ia: number | null
          telefone: string | null
          valor_estimado: number | null
          veredito_ia: string | null
        }
        SetofOptions: {
          from: "*"
          to: "negocios"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      escalate_stale_handoffs: { Args: never; Returns: number }
      expirar_reservas_loja: { Args: { _minutos?: number }; Returns: number }
      get_authorized_orgs: {
        Args: { role?: Database["public"]["Enums"]["role"] }
        Returns: string[]
      }
      get_iptv_token: { Args: { p_servidor_id: string }; Returns: string }
      get_leads_externos_config: {
        Args: never
        Returns: {
          secret_key: string
          url: string
        }[]
      }
      get_loja_numero_token: { Args: { p_numero_id: string }; Returns: string }
      get_model_api_key: {
        Args: { p_organization_id: string }
        Returns: string
      }
      get_voz_api_key: { Args: { p_organization_id: string }; Returns: string }
      get_whatsapp_access_token: {
        Args: { p_address: string; p_organization_id: string }
        Returns: string
      }
      has_iptv_token: { Args: { p_servidor_id: string }; Returns: boolean }
      has_model_api_key: {
        Args: { p_organization_id: string }
        Returns: boolean
      }
      has_voz_api_key: { Args: { p_organization_id: string }; Returns: boolean }
      hash_api_key: { Args: { p_key: string }; Returns: string }
      init_data: {
        Args: {
          p_limit?: number
          p_organization_id: string
          p_per_conversation?: number
          p_since?: string
          p_until?: string
        }
        Returns: Json
      }
      iptv_token_secret_name: {
        Args: { p_servidor_id: string }
        Returns: string
      }
      loja_numero_token_secret_name: {
        Args: { p_numero_id: string }
        Returns: string
      }
      marcar_reuniao_negocio: {
        Args: { _negocio: string; _quando: string }
        Returns: {
          abertura_sugerida: string | null
          atualizado_em: string
          categoria: string | null
          cidade: string | null
          cidade_normalizada: string | null
          conversation_id: string | null
          criado_em: string
          dores_identificadas: Json | null
          estado_normalizado: string | null
          estagio: string
          externo_id: string | null
          extra: Json | null
          id: string
          motivo_ia: string | null
          motivo_perda: string | null
          nicho: string | null
          nome: string
          organization_id: string
          origem: string
          origem_localizacao: string | null
          responsavel_id: string | null
          reuniao_em: string | null
          score_ia: number | null
          telefone: string | null
          valor_estimado: number | null
          veredito_ia: string | null
        }
        SetofOptions: {
          from: "*"
          to: "negocios"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      matches_campaign_audience: {
        Args: {
          p_audience: Json
          p_contact: Database["public"]["Tables"]["contacts"]["Row"]
        }
        Returns: boolean
      }
      member_self_update_rules: {
        Args: {
          p_ai: boolean
          p_extra: Json
          p_id: string
          p_organization_id: string
          p_user_id: string
        }
        Returns: boolean
      }
      merge_update_jsonb: {
        Args: { object: Json; path: string[]; target: Json }
        Returns: Json
      }
      model_key_secret_name: {
        Args: { p_organization_id: string }
        Returns: string
      }
      org_update_by_admin_rules: {
        Args: { p_id: string; p_name: string }
        Returns: boolean
      }
      organization_tags: {
        Args: { p_organization_id: string }
        Returns: {
          contacts: number
          tag: string
        }[]
      }
      painel_da_equipe: { Args: { p_org: string }; Returns: Json }
      painel_do_periodo: {
        Args: { p_ate?: string; p_desde: string; p_org: string }
        Returns: Json
      }
      professional_of_caller: {
        Args: { _organization_id: string }
        Returns: string
      }
      quitar_cobranca: {
        Args: {
          _agente?: string
          _cobranca: string
          _external_id?: string
          _metodo?: string
        }
        Returns: {
          agent_id: string | null
          codigo_pix: string | null
          combinado_para: string | null
          conta: string | null
          contact_address: string
          conversation_id: string
          created_at: string
          expira_em: string | null
          external_id: string | null
          id: string
          itens: Json
          metodo: string | null
          nota: string | null
          organization_id: string
          paga_em: string | null
          recibo_em: string | null
          status: string
          updated_at: string
          validade_dias: number | null
          valor: number
          valor_pago: number
          vence_em: string | null
        }
        SetofOptions: {
          from: "*"
          to: "cobrancas"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      quitar_pedido_loja: {
        Args: { _external_id?: string; _metodo?: string; _pedido: string }
        Returns: {
          codigo_pix: string | null
          comprador_user_id: string | null
          conectado_em: string | null
          conectado_por: string | null
          criado_em: string
          external_id: string | null
          id: string
          metodo: string | null
          numero_id: string
          organization_id: string
          pago_em: string | null
          status: string
          valor: number
        }
        SetofOptions: {
          from: "*"
          to: "loja_pedidos"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      receber_parcial: {
        Args: {
          _agente?: string
          _cobranca: string
          _combinado_para?: string
          _conta?: string
          _metodo?: string
          _nota?: string
          _valor: number
        }
        Returns: {
          agent_id: string | null
          codigo_pix: string | null
          combinado_para: string | null
          conta: string | null
          contact_address: string
          conversation_id: string
          created_at: string
          expira_em: string | null
          external_id: string | null
          id: string
          itens: Json
          metodo: string | null
          nota: string | null
          organization_id: string
          paga_em: string | null
          recibo_em: string | null
          status: string
          updated_at: string
          validade_dias: number | null
          valor: number
          valor_pago: number
          vence_em: string | null
        }
        SetofOptions: {
          from: "*"
          to: "cobrancas"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      remover_gateway: {
        Args: { _apagar?: boolean; _org: string }
        Returns: undefined
      }
      render_campaign_template: {
        Args: {
          p_campaign: Database["public"]["Tables"]["campaigns"]["Row"]
          p_contact: Database["public"]["Tables"]["contacts"]["Row"]
        }
        Returns: Json
      }
      reservar_numero_loja: {
        Args: { _numero: string; _organization_id: string; _user_id?: string }
        Returns: {
          codigo_pix: string | null
          comprador_user_id: string | null
          conectado_em: string | null
          conectado_por: string | null
          criado_em: string
          external_id: string | null
          id: string
          metodo: string | null
          numero_id: string
          organization_id: string
          pago_em: string | null
          status: string
          valor: number
        }
        SetofOptions: {
          from: "*"
          to: "loja_pedidos"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      salvar_gateway: {
        Args: {
          _org: string
          _provedor?: string
          _publica: string
          _secreta: string
          _webhook?: string
        }
        Returns: undefined
      }
      set_contact_address_blocked: {
        Args: {
          p_address: string
          p_blocked?: boolean
          p_service: Database["public"]["Enums"]["service"]
        }
        Returns: undefined
      }
      set_iptv_token: {
        Args: { p_servidor_id: string; p_token: string }
        Returns: undefined
      }
      set_loja_numero_token: {
        Args: { p_numero_id: string; p_token: string }
        Returns: undefined
      }
      set_message_hidden: {
        Args: { p_hidden?: boolean; p_message_id: string }
        Returns: undefined
      }
      set_model_api_key: {
        Args: { p_key: string; p_organization_id: string }
        Returns: undefined
      }
      set_vault_secret: {
        Args: { p_name: string; p_value: string }
        Returns: undefined
      }
      set_voz_api_key: {
        Args: { p_key: string; p_organization_id: string }
        Returns: undefined
      }
      set_whatsapp_access_token: {
        Args: { p_address: string; p_organization_id: string; p_token: string }
        Returns: undefined
      }
      sincronizar_negocios_externos: {
        Args: { p_linhas: Json }
        Returns: number
      }
      start_campaign: { Args: { p_campaign_id: string }; Returns: number }
      vencimento_da_cobranca: {
        Args: { _cobranca: string; _quando?: string }
        Returns: string
      }
      voz_key_secret_name: {
        Args: { p_organization_id: string }
        Returns: string
      }
      whatsapp_token_secret_name: {
        Args: { p_address: string; p_organization_id: string }
        Returns: string
      }
    }
    Enums: {
      appointment_status: "scheduled" | "done" | "cancelled" | "no_show"
      campaign_status:
        | "draft"
        | "scheduled"
        | "running"
        | "paused"
        | "completed"
        | "canceled"
      direction: "incoming" | "outgoing" | "internal"
      log_level: "info" | "warning" | "error"
      role: "owner" | "admin" | "member"
      service:
        | "whatsapp"
        | "instagram"
        | "local"
        | "slack"
        | "discord"
        | "teams"
        | "whatsapp-web"
      waitlist_status: "waiting" | "offered" | "taken" | "expired" | "cancelled"
      webhook_operation: "insert" | "update"
      webhook_table:
        | "messages"
        | "conversations"
        | "organizations_addresses"
        | "contacts"
        | "contacts_addresses"
        | "logs"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  billing: {
    Enums: {},
  },
  public: {
    Enums: {
      appointment_status: ["scheduled", "done", "cancelled", "no_show"],
      campaign_status: [
        "draft",
        "scheduled",
        "running",
        "paused",
        "completed",
        "canceled",
      ],
      direction: ["incoming", "outgoing", "internal"],
      log_level: ["info", "warning", "error"],
      role: ["owner", "admin", "member"],
      service: [
        "whatsapp",
        "instagram",
        "local",
        "slack",
        "discord",
        "teams",
        "whatsapp-web",
      ],
      waitlist_status: ["waiting", "offered", "taken", "expired", "cancelled"],
      webhook_operation: ["insert", "update"],
      webhook_table: [
        "messages",
        "conversations",
        "organizations_addresses",
        "contacts",
        "contacts_addresses",
        "logs",
      ],
    },
  },
} as const
