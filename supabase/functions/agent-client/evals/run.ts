import { Toolbox } from "../tools/index.ts";
import {
  coerceRespondMessages,
  RESPOND_TOOL,
} from "../protocols/chat-completions.ts";
import { buildRuntimeContext } from "../protocols/context.ts";
import { cases, type EvalCase } from "./cases.ts";

/**
 * # A suíte de avaliação do assistente
 *
 * Roda os casos de `cases.ts` contra o modelo de verdade, com as ferramentas
 * de verdade, e diz quantas vezes cada comportamento aconteceu.
 *
 * ## Por que existe
 *
 * Esta semana, cada defeito do assistente foi encontrado à mão: mandar a mesma
 * mensagem seis vezes e contar. Foi assim que se descobriu que a transferência
 * falhava metade das vezes e que um provedor devolvia argumentos corrompidos em
 * duas de oito chamadas. Aquelas medições foram jogadas fora depois de rodar, e
 * na semana seguinte a mesma pergunta precisou ser medida de novo. Isto é
 * aquilo, guardado.
 *
 * ## O que ela mede, e o que não mede
 *
 * Mede a trajetória: qual ferramenta foi chamada, se houve resposta para o
 * cliente, e o que nunca pode aparecer no texto. Não julga a redação — isso
 * seria transformar a suíte numa questão de gosto que quebra sozinha.
 *
 * As ferramentas não são executadas. O que se avalia é a escolha, que é onde
 * os defeitos estiveram. Chamar o banco aqui tornaria a suíte lenta, cara e
 * dependente de dado que muda.
 *
 * ## Custo
 *
 * Cada caso é uma chamada por repetição — hoje 42 no total, mensagens curtas.
 * Com um modelo de US$ 0,20 por milhão de tokens de saída, a suíte inteira sai
 * por centavos. É barata de propósito: suíte cara não roda.
 *
 * ## Como rodar
 *
 *   deno task evals
 *
 * A chave vem de `.env.evals` na raiz do repositório — uma linha,
 * `OPENROUTER_API_KEY=sk-or-...`. O arquivo é ignorado pelo git (`.env*`), e
 * fica fora do cofre do Supabase de propósito: o cofre não devolve o que
 * guarda, e uma suíte que só roda no servidor não roda antes de implantar.
 *
 * Variáveis opcionais: `EVAL_MODEL` e `EVAL_PROVIDER` (JSON de roteamento).
 * Sai com código 1 quando algum caso fica abaixo do piso, para poder entrar na
 * integração contínua sem mais nada.
 *
 * ## Por que ela precisa virar hábito
 *
 * Em 2026/08/07 o assistente passou horas com uma falha em cada três mensagens
 * — implantada por mim, direto na produção, e encontrada por acidente enquanto
 * eu testava outra coisa. Um cliente teria encontrado antes. A suíte existia e
 * não rodava; existir não conta. - 2026/08/05, revisto em 2026/08/07
 */

const KEY = Deno.env.get("OPENROUTER_API_KEY");
const MODEL = Deno.env.get("EVAL_MODEL") ?? "openai/gpt-oss-120b";
const PROVIDER = Deno.env.get("EVAL_PROVIDER") ??
  '{"order":["Cerebras","Together"]}';

if (!KEY) {
  console.error(
    "Falta OPENROUTER_API_KEY. A suíte chama o modelo de verdade — é esse o ponto.",
  );
  Deno.exit(2);
}

/**
 * As ferramentas exatamente como o backend as manda.
 *
 * Importadas de `Toolbox`, e não redigitadas aqui: metade dos defeitos desta
 * semana estava na descrição de uma ferramenta, e uma cópia da descrição numa
 * suíte de teste é uma cópia que não acusa quando a original muda.
 */
const tools = [
  ...Toolbox.function.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  })),
  RESPOND_TOOL,
];

/** O mesmo contexto de execução que o agente recebe, com uma data fixa. */
function runtimeBlock(): string {
  const runtime = buildRuntimeContext(
    {
      organization: {
        extra: {
          timezone: "America/Sao_Paulo",
          /**
           * O catálogo entra porque o sistema passou a mandá-lo em 2026/08/07.
           *
           * Sem ele a suíte mediria um contexto que não existe mais — e o
           * defeito que motivou a mudança ("vocês fazem barba?" respondido com
           * "sim, fazemos") não teria como aparecer aqui.
           */
          appointments: {
            services: [
              { name: "Corte", minutes: 30 },
              { name: "Corte + barba", minutes: 60 },
              { name: "Sobrancelha", minutes: 15 },
            ],
          },
          business_hours: [
            null,
            null,
            { from: "09:00", to: "19:00" },
            { from: "09:00", to: "19:00" },
            { from: "09:00", to: "19:00" },
            { from: "09:00", to: "19:00" },
            { from: "09:00", to: "17:00" },
          ],
        },
      },
      conversation: { contact_address: "5511999999999", service: "whatsapp" },
      contact: { name: "Cliente" },
      agent: { extra: {} },
    } as unknown as Parameters<typeof buildRuntimeContext>[0],
  );

  return `\n\n<runtime>\n${JSON.stringify(runtime, null, 2)}\n</runtime>`;
}

type Outcome = {
  tool: string | null;
  text: string;
  /** O modelo embrulhou a resposta num arquivo que não é arquivo. */
  disguised?: boolean;
  error?: string;
};

async function callOnce(testCase: EvalCase): Promise<Outcome> {
  const messages = [
    { role: "system", content: testCase.instructions + runtimeBlock() },
    ...(testCase.history ?? []),
    { role: "user", content: testCase.message },
  ];

  const response = await fetch(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        tools,
        tool_choice: "required",
        temperature: 1,
        reasoning: { effort: "low" },
        provider: JSON.parse(PROVIDER),
      }),
    },
  );

  const body = await response.json();

  if (body.error) return { tool: null, text: "", error: body.error.message };

  const call = body.choices?.[0]?.message?.tool_calls?.[0];

  if (!call) {
    return {
      tool: null,
      text: "",
      error: `sem ferramenta (finish_reason ${
        body.choices?.[0]?.finish_reason
      })`,
    };
  }

  let args: Record<string, unknown> = {};

  try {
    args = JSON.parse(call.function.arguments || "{}");
  } catch {
    return {
      tool: call.function.name,
      text: "",
      error: "argumentos ilegíveis",
    };
  }

  /**
   * O texto pelo mesmo leitor que a produção usa.
   *
   * Ler `message.text` cru mediria o esquema, não o atendimento: o modelo manda
   * a resposta em meia dúzia de formas e o backend tolera todas. Uma delas —
   * `{type:"file", uri:"text://Oi, tudo bem?"}` — derrubou uma em cada três
   * conversas em 2026/08/07 até o leitor passar a reconhecê-la.
   *
   * `disguised` conta quantas vezes o modelo fez isso. Não reprova o caso: o
   * cliente recebe a mensagem hoje. Serve para saber se o hábito aumenta —
   * porque no dia em que aumentar, o leitor é o próximo a quebrar.
   */
  const parts = call.function.name === "respond"
    ? coerceRespondMessages(args.messages)
    : [];

  const disguised = call.function.name === "respond" &&
    ((args.messages ?? []) as { type?: string; uri?: string }[]).some(
      (message) =>
        message?.type === "file" && !message.uri?.startsWith("internal://"),
    );

  const text = parts
    .map((part) => (part.type === "text" ? part.text : (part.text ?? "")))
    .join("\n");

  return { tool: call.function.name, text, disguised };
}

/** Se uma execução satisfaz o caso. */
function passes(testCase: EvalCase, outcome: Outcome): boolean {
  if (outcome.error) return false;

  if (testCase.expectTool && outcome.tool !== testCase.expectTool) return false;

  if (testCase.forbidTools?.includes(outcome.tool ?? "")) return false;

  if (testCase.expectAnswer && !outcome.text.trim()) return false;

  // Só olha o texto quando houve texto: um caso que proíbe markdown não é
  // violado por uma chamada de ferramenta legítima.
  if (
    testCase.forbidText && outcome.text &&
    testCase.forbidText.test(outcome.text)
  ) {
    return false;
  }

  return true;
}

let failed = 0;

console.log(`modelo ${MODEL} · provedor ${PROVIDER}\n`);

for (const testCase of cases) {
  const outcomes: Outcome[] = [];

  for (let attempt = 0; attempt < testCase.repeat; attempt++) {
    try {
      outcomes.push(await callOnce(testCase));
    } catch (error) {
      outcomes.push({
        tool: null,
        text: "",
        error: String(error).slice(0, 60),
      });
    }
  }

  const passed = outcomes.filter((outcome) => passes(testCase, outcome)).length;
  const ok = passed >= testCase.minPass;

  if (!ok) failed++;

  console.log(
    `${
      ok ? "ok  " : "FALHA"
    } ${passed}/${testCase.repeat} (piso ${testCase.minPass})  ${testCase.name}`,
  );

  if (!ok) {
    // O que aconteceu nas que não passaram, para o conserto começar com a
    // evidência em vez de uma segunda rodada de medição.
    for (const outcome of outcomes.filter((o) => !passes(testCase, o))) {
      console.log(
        `        → ${outcome.error ?? `chamou ${outcome.tool}`}: ${
          outcome.text.replace(/\n/g, " ").slice(0, 80)
        }`,
      );
    }
  }
}

console.log(
  failed
    ? `\n${failed} de ${cases.length} abaixo do piso.`
    : `\n${cases.length} casos no piso ou acima.`,
);

Deno.exit(failed ? 1 : 0);
