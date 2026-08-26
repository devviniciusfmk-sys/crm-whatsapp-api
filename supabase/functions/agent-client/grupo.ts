/**
 * # O assistente não fala em grupo
 *
 * O gatilho do banco dispara em TODA mensagem que entra
 * (`handle_incoming_message_to_agent`), e o `agent-client` não tinha uma linha
 * sequer sobre grupo. Enquanto o único canal ligado é a API oficial da Meta
 * isso nunca apareceu, porque a Meta não entrega grupo nenhum. No dia em que a
 * ponte não-oficial (`whatsapp-web`) subir, os grupos passam a cair aqui como
 * qualquer conversa — e o robô tenta responder dentro deles.
 *
 * São dois estragos diferentes, e por isso duas razões separadas abaixo:
 *
 *   grupo             o assistente fala no seu grupo, na frente dos seus
 *                     clientes, respondendo a uma conversa que não é com ele.
 *                     Constrangedor, e a pessoa que "pediu" nem falou com você.
 *
 *   sem destinatário  a resposta é montada com `conv.contact_address`, e numa
 *                     conversa de grupo esse campo é nulo por definição
 *                     (`conversations`: "one of contact_address or
 *                     group_address"). O envio quebra, ou vai para lugar
 *                     nenhum, e o erro aparece longe daqui.
 *
 * A segunda vale sozinha, sem grupo nenhum: qualquer conversa sem endereço de
 * contato é uma conversa para a qual não há como responder. Guardar as duas no
 * mesmo lugar é o que impede alguém de "consertar" uma e deixar a outra.
 *
 * ## Nada de bilhete aqui
 *
 * As outras saídas do `agent-client` deixam um bilhete de retorno — "me chama
 * às 19" não pode se perder quando o assistente cala. Em grupo esse cuidado se
 * inverte: não há cliente pedindo retorno, há gente conversando entre si, e um
 * bilhete por mensagem encheria a caixa de tarefas de ruído até ninguém mais
 * olhar para ela.
 *
 * ## Ler continua valendo
 *
 * Isto silencia o assistente, e só. A mensagem de grupo continua sendo
 * gravada, continua aparecendo na caixa de entrada com o nome do grupo e com
 * quem falou, e continua disponível para quem quiser lê-la ou resumi-la
 * depois. Calar não é deixar de escutar. - 2026/08/23
 */
export type MotivoDoSilencio = "grupo" | "sem-destinatario";

export function porQueNaoResponder(
  conversa: {
    group_address?: string | null;
    contact_address?: string | null;
  },
): MotivoDoSilencio | null {
  /* Grupo primeiro: uma conversa de grupo também está sem destinatário, e
   * "grupo" é a razão que explica o que aconteceu. Na ordem inversa, o registro
   * diria "sem destinatário" para toda mensagem de grupo — verdade inútil, do
   * tipo que faz alguém procurar o defeito no lugar errado. */
  if (conversa.group_address) return "grupo";

  if (!conversa.contact_address) return "sem-destinatario";

  return null;
}
