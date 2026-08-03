import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ToolDefinition } from "./base.ts";
import type { RequestContext } from "../protocols/base.ts";

/**
 * Guardar na ficha o que o cliente disser sobre si.
 *
 * O que a pessoa informa no meio da conversa — e-mail para a nota fiscal, o
 * endereço da entrega, o CPF do cadastro — hoje ficava só no texto da
 * conversa. Encontrar de novo significa alguém rolar o histórico, e um mês
 * depois ninguém rola.
 *
 * Três travas, e as três importam:
 *
 * **Só o contato desta conversa.** Não há parâmetro de telefone. Um modelo com
 * poder de escrever na ficha de qualquer pessoa é um jeito educado de pedir
 * para ele gravar o CPF de um cliente na ficha de outro.
 *
 * **Só o que foi dito.** A descrição insiste, e a validação recusa campo
 * vazio: modelo pediu para preencher uma ficha tende a completar o que falta,
 * e ficha com CPF inventado é pior que ficha vazia.
 *
 * **Só se ligada.** A ferramenta é opcional no agente. Guardar documento de
 * quem não pediu é tratamento de dado pessoal por conta própria, e essa é
 * decisão de quem opera, não padrão nosso. - 2026/08/03
 */

const InputSchema = z.object({
  name: z.string().optional().describe(
    "The customer's own name, as they gave it. ALWAYS include this when they introduce themselves — 'my name is X', 'it's for X' — even if you are saving other fields at the same time. Not their WhatsApp profile name: only what they told you.",
  ),
  email: z.string().optional().describe("Email address, exactly as given."),
  document: z.string().optional().describe(
    "Tax ID (in Brazil, CPF or CNPJ), exactly as given, digits and punctuation included.",
  ),
  address: z.string().optional().describe("Postal address, as given."),
  birthday: z.string().optional().describe(
    "Date of birth as YYYY-MM-DD. Only if stated; never guess the year.",
  ),
  notes: z.string().optional().describe(
    "Anything else worth keeping on file that the customer said about themselves — an allergy, a preference, who to ask for. WRITE IT IN THE LANGUAGE OF THE CONVERSATION: the business's staff reads it.",
  ),
});

const OutputSchema = z.object({
  saved: z.array(z.string()).describe("Which fields were written."),
  refused: z.string().nullable(),
});

async function implementation(
  input: z.infer<typeof InputSchema>,
  _config: void,
  context: RequestContext,
  supabaseClient: SupabaseClient,
): Promise<z.infer<typeof OutputSchema>> {
  const address = context.conversation.contact_address;

  if (!address) {
    return { saved: [], refused: "This conversation has no contact to save." };
  }

  // Campo declarado mas em branco é o modelo preenchendo formulário, não o
  // cliente informando. Cortado antes de chegar ao banco.
  const entries = Object.entries(input).filter(
    ([, value]) => typeof value === "string" && value.trim().length > 0,
  ) as [string, string][];

  if (!entries.length) {
    return { saved: [], refused: "Nothing to save: no value was given." };
  }

  const { data: link } = await supabaseClient
    .from("contacts_addresses")
    .select("contact_id")
    .eq("organization_id", context.organization.id)
    .eq("service", context.conversation.service)
    .eq("address", address)
    .maybeSingle();

  const contactId = link?.contact_id as string | null | undefined;

  if (!contactId) {
    return { saved: [], refused: "This contact has no record to write to." };
  }

  const { name, ...rest } = Object.fromEntries(
    entries.map(([key, value]) => [key, value.trim()]),
  ) as Record<string, string>;

  // `extra` tem trigger de merge, então isto acrescenta sem apagar o que a
  // equipe já preencheu nos outros campos. O campo informado de novo é
  // sobrescrito de propósito: gente muda de endereço, e uma ficha que não
  // aceita correção envelhece errada.
  const changes: Record<string, unknown> = {};

  if (Object.keys(rest).length) changes.extra = rest;
  if (name) changes.name = name;

  const { error } = await supabaseClient
    .from("contacts")
    .update(changes)
    .eq("id", contactId);

  if (error) return { saved: [], refused: error.message };

  return { saved: entries.map(([key]) => key), refused: null };
}

export const SaveContactDetailsTool: ToolDefinition<
  typeof InputSchema,
  typeof OutputSchema
> = {
  provider: "local",
  type: "function",
  name: "save_contact_details",
  description:
    "Save on the customer's record something they told you about themselves — their name, email, tax ID, address, birthday, or a note. ONLY pass a field the customer actually stated in this conversation: never infer, complete or invent one, and leave out anything you were not told. It writes to the record of the person you are talking to and to nobody else. Do not ask for personal data the conversation does not need.",
  inputSchema: z.toJSONSchema(InputSchema),
  outputSchema: z.toJSONSchema(OutputSchema),
  implementation,
};
