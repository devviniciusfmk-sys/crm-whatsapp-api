import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ToolDefinition } from "./base.ts";
import type { RequestContext } from "../protocols/base.ts";

/**
 * # O cartão de fidelidade, do lado de quem enche o cartão
 *
 * A tela do dono já contava — "Cartão · 9 de 10" no formulário, e a cortesia em
 * vermelho na lista do dia. Faltava o outro lado: o cliente que enche o cartão
 * não tinha como saber onde está, e um cartão que só o dono enxerga não fideliza
 * ninguém. Era a inversão do produto — o recurso existia para quem já paga a
 * mensalidade, e não para quem faz a loja valer a pena.
 *
 * ## Sem trava de identidade, e isso é de propósito
 *
 * `my_schedule` e `my_earnings` conferem o telefone porque entregam informação
 * de OUTRAS pessoas — a agenda tem o nome dos clientes, a comissão tem a régua
 * da loja. Aqui não: a ferramenta lê o número de quem está escrevendo e devolve
 * só o que é dele. Não há como pedir o cartão do vizinho porque não há onde
 * dizer de quem é o cartão.
 *
 * ## Conta o que aconteceu, não o que está marcado
 *
 * Só `done`. Quem marcou dez e faltou em três tem sete, e é isso que a régua do
 * balcão diz. Contar o marcado deixaria a assistente prometer uma cortesia que
 * some quando alguém não aparece — e ninguém desiste de um prêmio calado.
 *
 * ## O que ela NÃO diz
 *
 * "Você tem uma cortesia disponível". Não existe resgate ainda: sem registrar
 * qual atendimento consumiu o prêmio, o contador ficaria no décimo para sempre
 * e a assistente prometeria de graça toda semana. Ela diz que ESTE é o décimo —
 * um fato — e manda confirmar no balcão. - 2026/08/13
 */

/**
 * Onde este cliente está no cartão, ou nulo quando não há cartão.
 *
 * Fora da ferramenta para poder ser testada sem banco — e porque o erro que
 * importa aqui é aritmético, não de consulta: no múltiplo exato o resto é ZERO,
 * e a leitura ingênua diria "0 de 10" a quem acabou de fechar o cartão.
 *
 * Espelha `posicaoNoCartao` da tela (open-bsp-ui, `queries/useLoyalty.ts`). Duas
 * cópias da mesma conta é o que existe hoje entre os dois repositórios; o que
 * não pode é elas discordarem, e por isso as duas têm o mesmo caso de borda
 * escrito no teste.
 */
export function posicaoNoCartao(
  desdeAUltimaCortesia: number,
  every: number | undefined | null,
): { noCartao: number; alvo: number; chegou: boolean } | null {
  if (!every || every < 2) return null;

  return {
    noCartao: desdeAUltimaCortesia,
    alvo: every,
    chegou: desdeAUltimaCortesia >= every,
  };
}

/**
 * Quantos atendimentos desde a última cortesia.
 *
 * As linhas chegam em ordem de data. Cada cortesia zera a contagem, e ela mesma
 * não conta para o cartão seguinte: foi o prêmio, e não uma visita a caminho do
 * próximo.
 *
 * Substituiu o resto da divisão, que só acertava se todo prêmio fosse consumido
 * exatamente no múltiplo — e a vida não faz isso. O cliente esquece de pedir e
 * usa no décimo segundo; o balcão dá a cortesia no nono porque ele reclamou.
 */
export function desdeAUltimaCortesia(
  atendimentos: { extra?: { payment_method?: string } | null }[],
): number {
  let conta = 0;

  for (const a of atendimentos) {
    conta = a.extra?.payment_method === "courtesy" ? 0 : conta + 1;
  }

  return conta;
}

const LoyaltyInputSchema = z.object({});

const LoyaltyOutputSchema = z.object({
  every: z.number().nullable().describe(
    "How many attended appointments earn the reward. Null means this shop has no loyalty card — then say so plainly and do not invent one.",
  ),
  reward: z.string().nullable().describe("What they get, in the owner's words."),
  attended: z.number().describe("How many they have ever attended here."),
  on_card: z.number().describe("How far along the CURRENT card they are."),
  remaining: z.number().describe(
    "HOW MANY MORE VISITS THEY NEED. This is the number to say out loud — do not subtract anything yourself. Saying 'faltam 0' when they have just started a fresh card is the exact mistake this field exists to prevent: `on_card` is progress, not what is left.",
  ),
  reached: z.boolean().describe(
    "True when this many attended appointments completes a card. Say that the next one is the reward and ask them to confirm at the counter — never state that a reward is already banked, because the system does not track redemption yet.",
  ),
  refused: z.string().nullable(),
});

async function loyaltyImplementation(
  _input: z.infer<typeof LoyaltyInputSchema>,
  _config: void,
  context: RequestContext,
  supabaseClient: SupabaseClient,
): Promise<z.infer<typeof LoyaltyOutputSchema>> {
  const extra = context.organization.extra as
    | { loyalty?: { every?: number; reward?: string } }
    | null;

  const every = extra?.loyalty?.every ?? null;

  /**
   * Sem cartão configurado, ela recusa antes de contar.
   *
   * O servidor não conhece a lista de módulos da loja — quem a guarda é a tela.
   * Mas `every` é a mesma coisa por outro caminho: um cartão sem número não é
   * um cartão, e é assim que a tela também o desliga.
   */
  if (!every || every < 2) {
    return {
      every: null,
      reward: null,
      attended: 0,
      on_card: 0,
      remaining: 0,
      reached: false,
      refused:
        "This shop does not run a loyalty card. Say so plainly if they ask, and do NOT promise free visits, discounts or points.",
    };
  }

  const { data } = await supabaseClient
    .from("appointments")
    .select("extra, starts_at")
    .eq("organization_id", context.organization.id)
    .eq("contact_address", context.conversation.contact_address)
    .eq("status", "done")
    .order("starts_at");

  const linhas = (data ?? []) as {
    extra?: { payment_method?: string } | null;
  }[];

  const noCartao = desdeAUltimaCortesia(linhas);
  const posicao = posicaoNoCartao(noCartao, every)!;

  return {
    every,
    reward: extra?.loyalty?.reward ?? null,
    attended: linhas.length,
    on_card: posicao.noCartao,
    remaining: Math.max(0, every - posicao.noCartao),
    reached: posicao.chegou,
    refused: null,
  };
}

export const LoyaltyCardTool: ToolDefinition<
  typeof LoyaltyInputSchema,
  typeof LoyaltyOutputSchema
> = {
  provider: "local",
  type: "function",
  name: "loyalty_card",
  description:
    "Tell the CUSTOMER writing to you where they stand on the shop's loyalty card — 'quantos cortes faltam pro meu grátis?', 'tenho cartão fidelidade?', 'já ganhei alguma coisa?'. It reads the number they are writing from and answers only about them, so there is nothing to verify. SAY `remaining` AS IT COMES: it is already how many visits are left, and doing the subtraction yourself is how 'faltam 0' gets told to somebody who just started a fresh card. Name the reward with the shop's own words from `reward` — do not substitute your own, a barbershop whose prize is a free beard trim must not be told it is a free haircut. Only ATTENDED visits count: somebody who booked ten and missed three has seven. When `reached` is true, say their NEXT visit is the one on the house and to confirm it at the counter. When `every` is null this shop has no card: say so and promise nothing. ALWAYS REPLY IN THE LANGUAGE THEY ARE USING.",
  inputSchema: z.toJSONSchema(LoyaltyInputSchema),
  outputSchema: z.toJSONSchema(LoyaltyOutputSchema),
  implementation: loyaltyImplementation,
};
