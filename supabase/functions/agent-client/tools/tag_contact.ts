import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ToolDefinition } from "./base.ts";
import type { RequestContext } from "../protocols/base.ts";

/**
 * Etiquetar o contato desta conversa.
 *
 * Quem melhor sabe que a pessoa perguntou preço de peeling, ou que sumiu há
 * seis meses, ou que veio do Instagram, é quem estava na conversa — e quando é
 * o assistente que atende, a informação morre no histórico. A etiqueta é o que
 * transforma isso em público de campanha depois.
 *
 * As travas são as mesmas da ficha, pelas mesmas razões:
 *
 * **Só o contato desta conversa.** Não há parâmetro de telefone. Um modelo que
 * possa etiquetar qualquer pessoa é um modelo que um dia marca o cliente errado
 * como "caloteiro".
 *
 * **Acrescenta, nunca substitui a lista.** O modelo não recebe o que já está
 * gravado nem manda a lista inteira: manda a etiqueta que quer pôr ou tirar.
 * Mandar a lista completa significaria que esquecer uma apaga uma.
 *
 * **Minúscula e sem espaço nas pontas**, igual à tela — senão "VIP" do
 * assistente e "vip" de quem atende viram dois públicos, e o disparo vai para
 * metade das pessoas.
 *
 * **Só se ligada.** É opcional no agente, como as outras: classificar cliente é
 * decisão de quem opera. - 2026/08/04
 */

const InputSchema = z.object({
  tag: z.string().describe(
    "The single label to apply, as short as possible — one or two words, in the language of the business. Reuse a label the business already uses when one fits; do not invent a synonym for it. Never put personal data in a label: it is a group name, not a note.",
  ),
  remove: z.boolean().optional().describe(
    "Set true to take this label off the customer instead of putting it on.",
  ),
});

const OutputSchema = z.object({
  tags: z.array(z.string()).describe("The customer's labels after the change."),
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
    return { tags: [], refused: "This conversation has no contact to label." };
  }

  const tag = input.tag.trim().toLowerCase();

  if (!tag) {
    return { tags: [], refused: "Nothing to do: the label was empty." };
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
    return { tags: [], refused: "This contact has no record to label." };
  }

  // Lê para escrever: a coluna é um array e não há operador de append pelo
  // PostgREST. A janela entre a leitura e a escrita é o preço, e nesta escala
  // ela custa uma etiqueta perdida num empate — barato perto de dar ao modelo
  // o poder de mandar a lista inteira e apagar o que ele não citou.
  const { data: current, error: readError } = await supabaseClient
    .from("contacts")
    .select("tags")
    .eq("id", contactId)
    .single();

  if (readError) return { tags: [], refused: readError.message };

  const tags = (current?.tags ?? []) as string[];
  const next = input.remove
    ? tags.filter((item) => item !== tag)
    : tags.includes(tag)
      ? tags
      : [...tags, tag];

  if (next.length === tags.length && next.every((item, i) => item === tags[i])) {
    return { tags, refused: null };
  }

  const { error } = await supabaseClient
    .from("contacts")
    .update({ tags: next })
    .eq("id", contactId);

  if (error) return { tags, refused: error.message };

  return { tags: next, refused: null };
}

export const TagContactTool: ToolDefinition<
  typeof InputSchema,
  typeof OutputSchema
> = {
  provider: "local",
  type: "function",
  name: "tag_contact",
  description:
    "Put a label on the customer you are talking to, so the business can find this group later — for example the service they asked about, where they came from, or that they are a regular. One label per call; call it again for another. It labels the person you are talking to and nobody else. Use it when something in the conversation says which group this customer belongs to; do not ask them to pick a label, and do not announce that you labelled them.",
  inputSchema: z.toJSONSchema(InputSchema),
  outputSchema: z.toJSONSchema(OutputSchema),
  implementation,
};
