import type { SupabaseClient } from "@supabase/supabase-js";
import type { MessageRow } from "./supabase.ts";
import * as log from "./logger.ts";

/**
 * O custo de um envio de modelo, registrado no extrato.
 *
 * A Meta cobra por mensagem de modelo enviada — marketing, utilidade,
 * autenticação, com tarifa por país. Nada no sistema contava isso: os três
 * únicos caminhos que gravavam no extrato eram de IA. Uma campanha para mil
 * contatos custa, em ordem de grandeza, cem vezes um mês inteiro de assistente,
 * e esse dinheiro saía sem contador.
 *
 * ## Registra, não bloqueia
 *
 * De propósito. Interromper uma campanha no meio por causa de saldo é uma
 * decisão de produto que ninguém tomou ainda, e o estrago de parar um disparo
 * pela metade é maior que o de contar depois. `check_limit` continua fora daqui.
 *
 * ## O que não tem tarifa é contado, não ignorado
 *
 * Se falta a linha de preço do par categoria/país, ou se a categoria não é
 * conhecida, o envio ENTRA no extrato com quantidade zero e `priced: false`.
 * Zero silencioso viraria "não custou nada"; assim vira uma pergunta que se
 * responde com uma consulta — quantos envios saíram sem preço, e de onde.
 *
 * Não inventar a tarifa é a regra que importa aqui: número de cobrança errado
 * é pior que ausente. As tarifas vêm do rate card oficial da Meta e entram como
 * dado em `billing.costs`. - 2026/08/06
 */

/**
 * Prefixo telefônico → país, para achar a tarifa.
 *
 * Só os que sabemos precificar. Qualquer outro fica sem país, o envio entra sem
 * preço e aparece na contagem — que é melhor que atribuir a tarifa errada a um
 * número estrangeiro.
 */
const COUNTRY_BY_CALLING_CODE: Array<[string, string]> = [
  ["55", "br"],
  ["54", "ar"],
  ["1", "us"],
  ["351", "pt"],
];

export function countryFromPhone(phone?: string | null): string | undefined {
  if (!phone) return undefined;

  const digits = phone.replace(/\D/g, "");

  // Mais longo primeiro: "1" casaria com "351" se a ordem fosse a de cima.
  const match = [...COUNTRY_BY_CALLING_CODE]
    .sort((a, b) => b[0].length - a[0].length)
    .find(([code]) => digits.startsWith(code));

  return match?.[1];
}

export async function recordTemplateSend({
  client,
  message,
  to,
}: {
  client: SupabaseClient;
  message: MessageRow;
  to?: string;
}): Promise<void> {
  const content = message.content as { type?: string; data?: unknown };

  if (content?.type !== "template") return;

  // A categoria decide a tarifa, e só a campanha a declara. Um lembrete de
  // compromisso também é modelo, mas ninguém grava a categoria dele — e supor
  // "utilidade" seria supor um preço.
  let category: string | undefined;

  if (message.campaign_id) {
    const { data: campaign } = await client
      .from("campaigns")
      .select("template_category")
      .eq("id", message.campaign_id)
      .single();

    category = campaign?.template_category ?? undefined;
  }

  const country = countryFromPhone(to ?? message.contact_address);
  const product = category && country ? `${category}/${country}` : undefined;

  let cost = 0;

  if (product) {
    const { data: rate } = await client
      .schema("billing")
      .from("costs")
      .select("pricing, quantity")
      .eq("provider", "whatsapp")
      .eq("product", product)
      .lte("effective_at", new Date().toISOString())
      .order("effective_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (rate) {
      const price = (rate.pricing as { price?: number })?.price ?? 0;
      cost = price / Number(rate.quantity || 1);
    }
  }

  const priced = cost > 0;

  if (!priced) {
    log.warn("Template sent without a price", {
      message_id: message.id,
      category: category ?? "desconhecida",
      country: country ?? "desconhecido",
    });
  }

  await client
    .schema("billing")
    .from("ledger")
    .insert({
      organization_id: message.organization_id,
      product_id: "ai_credits",
      type: "consumption",
      quantity: -cost,
      message_id: message.id,
      provider: "whatsapp",
      model: product ?? "template",
      billable: true,
      metadata: {
        category: category ?? null,
        country: country ?? null,
        priced,
      },
    })
    .throwOnError();
}
