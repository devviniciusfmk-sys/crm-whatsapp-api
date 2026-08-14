import type { SupabaseClient } from "@supabase/supabase-js";
import { quandoFalar } from "../_shared/quando_falar.ts";
import { localToUtc, utcToLocal } from "./tools/appointments.ts";
import { DEFAULT_TIMEZONE } from "./protocols/context.ts";
import * as log from "../_shared/logger.ts";

/**
 * # O cutucão, para quando não há assistente para chamar a ferramenta
 *
 * Existem quatro portas por onde uma mensagem do cliente sai daqui sem
 * resposta: a conversa está pausada porque um humano digitou, a loja está
 * fechada e o dono manda pausar, não há assistente nenhum, ou o que há está
 * inativo. Nas quatro, `schedule_follow_up` nunca é chamada — e o "me chama às
 * 19" morre ali.
 *
 * Este módulo não responde nada e não manda nada. Ele deixa um bilhete na
 * conversa: "ele pediu retorno às 19h". A tela mostra um aviso de um toque
 * acima do teclado, e quem decide é quem está atendendo.
 *
 * ## Por que sugerir, e não agendar
 *
 * Porque a conversa é de outra pessoa. O gatilho da pausa existe para o robô
 * não atropelar quem digitou, e um agendamento automático seria exatamente
 * isso, só que com atraso: o dono resolveria o assunto na conversa e, horas
 * depois, uma mensagem do sistema chegaria falando de algo já resolvido. Ele
 * descobriria pelo cliente estranhando.
 *
 * Sugerir custa um aviso ignorável quando erra, e salva a promessa quando
 * acerta. Nenhum dos dois lados manda mensagem sem uma pessoa decidir.
 *
 * ## O que fica fora
 *
 * Só hoje e amanhã, e sempre dentro da janela de 24 horas — o aviso vira texto
 * livre, e texto livre fora da janela é aceito hoje e recusado pela Meta
 * depois, sem ninguém por perto. Quem quiser mais longe usa o botão de
 * agendar, que sabe escolher modelo. - 2026/08/13
 */

/**
 * A folga mínima entre agora e o retorno sugerido.
 *
 * A fila só recolhe mensagem com um minuto de idade, então algo marcado para
 * "daqui a dois minutos" sairia quase junto com o que o dono está digitando —
 * duas mensagens no mesmo minuto, uma delas dizendo "você pediu para eu te
 * chamar agora". Dez minutos é o menor intervalo em que o aviso ainda parece
 * um retorno.
 */
const FOLGA_MINIMA_MS = 10 * 60 * 1000;

/**
 * A borda da janela, com meia hora de sobra.
 *
 * A janela conta do último recado do cliente, que é a mensagem que acabou de
 * chegar. Encostar nas 24 horas exatas deixaria o envio na dependência de o
 * despachante estar em dia; meia hora de folga custa nada e tira o caso de
 * borda da mesa.
 */
const LIMITE_DA_JANELA_MS = 23.5 * 60 * 60 * 1000;

export type RetornoSugerido = {
  /** Quando sairia, em ISO UTC. */
  em: string;
  /** O trecho que foi lido, para o log dizer de onde veio. */
  lido: string;
  criado: string;
};

/** Lê a hora local como dois números, a partir do "YYYY-MM-DD HH:mm". */
function relogioLocal(timeZone: string) {
  const agora = utcToLocal(new Date(), timeZone);

  return {
    data: agora.slice(0, 10),
    hora: Number(agora.slice(11, 13)),
    minuto: Number(agora.slice(14, 16)),
  };
}

/** O dia seguinte de uma data "YYYY-MM-DD", sem passar pelo fuso. */
function diaSeguinte(data: string) {
  const [ano, mes, dia] = data.split("-").map(Number);
  const d = new Date(Date.UTC(ano, mes - 1, dia + 1));

  return d.toISOString().slice(0, 10);
}

export async function sugerirRetorno(input: {
  client: SupabaseClient;
  conversationId: string;
  timeZone?: string | null;
  texto: unknown;
}): Promise<RetornoSugerido | null> {
  const { client, conversationId, texto } = input;

  if (typeof texto !== "string" || !texto.trim()) return null;

  const timeZone = input.timeZone || DEFAULT_TIMEZONE;
  const relogio = relogioLocal(timeZone);

  const pedida = quandoFalar(texto, relogio);

  if (!pedida) return null;

  const dia = pedida.amanha ? diaSeguinte(relogio.data) : relogio.data;

  const quando = localToUtc(
    `${dia} ${String(pedida.hora).padStart(2, "0")}:${
      String(pedida.minuto).padStart(2, "0")
    }`,
    timeZone,
  );

  if (!quando) return null;

  const daqui = quando.getTime() - Date.now();

  if (daqui < FOLGA_MINIMA_MS || daqui > LIMITE_DA_JANELA_MS) return null;

  const sugestao: RetornoSugerido = {
    em: quando.toISOString(),
    lido: pedida.trecho,
    criado: new Date().toISOString(),
  };

  /**
   * Uma chave só, e o gatilho `merge_update` cuida do resto.
   *
   * Escrever o `extra` inteiro apagaria `default_agent_id` e `paused` — e
   * apagar `paused` religaria a assistente no meio de um atendimento humano,
   * que é o oposto exato do que este módulo existe para respeitar.
   */
  const { error } = await client
    .from("conversations")
    .update({ extra: { retorno_sugerido: sugestao } })
    .eq("id", conversationId);

  if (error) {
    log.error("sugerir retorno: não consegui gravar", error.message);
    return null;
  }

  log.info(
    `Retorno sugerido para ${conversationId}: ${
      utcToLocal(quando, timeZone)
    } (lido de "${pedida.trecho}")`,
  );

  return sugestao;
}
