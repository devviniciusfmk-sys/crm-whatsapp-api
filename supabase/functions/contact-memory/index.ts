import { createClient } from "@supabase/supabase-js";
import type {
  AIAgentExtra,
  ContactExtra,
} from "../_shared/types/extra_types.ts";
import type { MessageRow } from "../_shared/types/database_types.ts";

/**
 * # Memória do contato
 *
 * Escreve em `contacts.extra.summary` o que já se sabe de cada cliente, para o
 * assistente não reler a conversa inteira a cada mensagem.
 *
 * O problema que resolve é de janela, não de gosto. Uma conversa de seis meses
 * não cabe no contexto, e o pedaço que cabe é sempre o errado: o começo — onde
 * a pessoa disse que é alérgica, que prefere de manhã, que já reclamou uma vez
 * — é o primeiro a ser cortado. Cinco linhas atravessam meses; duzentas
 * mensagens não.
 *
 * Roda por cron, não no caminho da resposta. Resumir enquanto o cliente espera
 * seria pagar uma chamada de modelo por mensagem para reescrever quase a mesma
 * coisa, e atrasar justamente o que precisa ser rápido. Quem escolhe a fila é
 * `contacts_needing_memory`, que só devolve conversa parada há meia hora, com
 * novidade desde o último resumo e com mais de três mensagens.
 *
 * **Limite conhecido:** só resume para agentes com endereço e chave próprios
 * (`extra.api_url` + `extra.api_key`). Quem usa a chave da plataforma passa
 * pela contabilidade de créditos, que mora dentro do protocolo do agente e
 * está entrelaçada com a chamada do modelo. Duplicar aquilo aqui seria copiar
 * a parte do sistema que cobra — e uma segunda cópia de cobrança é a que
 * diverge. Fica para quando a resolução de credencial for extraída.
 *
 * Nada aqui inventa: o texto é o que as mensagens dizem, e a ficha é editável
 * e apagável na tela por quem atende. - 2026/08/04
 */

const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

/** Quantos contatos por rodada. Teto de gasto por tick, não de capacidade. */
const BATCH = 10;

/** Quantas mensagens do fim da conversa entram no resumo. */
const WINDOW = 60;

const PROMPT =
  `You keep a short memory of a customer for the business that serves them.

Write what is worth knowing the next time this person gets in touch, and nothing else:
what they buy or book, how often, what they prefer, constraints that matter (allergies,
schedules, access), and anything they asked to be remembered. Facts only — if the
conversation does not say it, it does not go in.

Rules:
- At most five short lines. No greeting, no preamble, no headings, no bullet characters.
- Write in the language the customer speaks.
- Third person, factual: "Prefere de manhã", not "O cliente disse que prefere de manhã".
- Leave out small talk, pleasantries, and anything already obvious from the phone number.
- Do NOT repeat identity data the record already holds — name, email, tax ID, postal
  address, date of birth. Those have their own fields; copying them here only makes
  them harder to correct and to erase when the person asks.
- Do NOT include the customer's own words verbatim if they are sensitive; summarise.
- If the conversation holds nothing worth remembering, answer exactly: NADA`;

type AgentRow = { id: string; extra: AIAgentExtra | null };

async function summarise(
  agent: AIAgentExtra,
  transcript: string,
): Promise<string | null> {
  const baseURL = String(agent.api_url).replace("/chat/completions", "");

  const response = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${agent.api_key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: agent.model,
      messages: [
        { role: "system", content: PROMPT },
        { role: "user", content: transcript },
      ],
      // Curto de propósito: um resumo que cresce deixa de ser resumo, e o
      // objetivo aqui é caber no contexto de toda mensagem futura.
      max_tokens: 300,
      temperature: 0.2,
      ...(agent.provider ? { provider: agent.provider } : {}),
    }),
  });

  if (!response.ok) {
    console.error(
      "memory: model returned",
      response.status,
      await response.text(),
    );
    return null;
  }

  const body = await response.json();
  const text = body?.choices?.[0]?.message?.content?.trim();

  if (!text || text === "NADA") return null;

  return text;
}

Deno.serve(async (req) => {
  const token = req.headers.get("Authorization")?.replace("Bearer ", "");

  if (token !== SERVICE_ROLE_KEY) {
    return new Response("Unauthorized", { status: 401 });
  }

  const client = createClient(
    Deno.env.get("SUPABASE_URL")!,
    SERVICE_ROLE_KEY,
    { auth: { persistSession: false } },
  );

  const { data: due, error } = await client.rpc("contacts_needing_memory", {
    p_limit: BATCH,
  });

  if (error) {
    console.error("memory: could not list contacts", error);
    return new Response(error.message, { status: 500 });
  }

  let written = 0;
  let skipped = 0;

  for (const row of due ?? []) {
    const { data: agents } = await client
      .from("agents")
      .select("id, extra")
      .eq("organization_id", row.organization_id);

    // O primeiro agente ativo com credencial própria. Ver o limite conhecido
    // no topo do arquivo.
    const agent = (agents as AgentRow[] ?? [])
      .map((a) => a.extra)
      .find((extra): extra is AIAgentExtra =>
        !!extra?.api_url && !!extra?.api_key && !!extra?.model &&
        extra.mode !== "inactive"
      );

    if (!agent) {
      skipped++;
      continue;
    }

    const { data: messages } = await client
      .from("messages")
      .select("direction, content, timestamp")
      .eq("conversation_id", row.conversation_id)
      .in("direction", ["incoming", "outgoing"])
      .order("timestamp", { ascending: false })
      .limit(WINDOW);

    const transcript = ((messages ?? []) as MessageRow[])
      .slice()
      .reverse()
      .map((m) => {
        const text = m.content?.type === "text" || m.content?.type === "file"
          ? m.content.text
          : undefined;

        if (!text) return null;

        return `${m.direction === "incoming" ? "Cliente" : "Empresa"}: ${text}`;
      })
      .filter(Boolean)
      .join("\n");

    if (!transcript) {
      skipped++;
      continue;
    }

    const summary = await summarise(agent, transcript);

    // `summary_at` é gravado mesmo quando não houve o que resumir. Sem isso, uma
    // conversa sem conteúdo voltaria à fila a cada rodada, para sempre, gastando
    // uma chamada de modelo por tentativa.
    const extra: ContactExtra = {
      summary_at: new Date().toISOString(),
      ...(summary ? { summary } : {}),
    };

    const { error: writeError } = await client
      .from("contacts")
      .update({ extra })
      .eq("id", row.contact_id);

    if (writeError) {
      console.error("memory: could not write summary", writeError);
      continue;
    }

    if (summary) written++;
    else skipped++;
  }

  console.log(`memory: ${written} written, ${skipped} skipped`);

  return Response.json({ due: due?.length ?? 0, written, skipped });
});
