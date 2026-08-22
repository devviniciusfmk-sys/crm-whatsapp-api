/**
 * # Qual plano gera o teste, quando ninguém diz qual
 *
 * Era "o mais antigo que estiver ativo", e isso quebra por um motivo banal:
 * criar um plano vazio é um clique, e um plano vazio ativo é indistinguível de
 * um pronto para quem só olha a data.
 *
 * Aconteceu na base do piloto em 2026/08/22 — dois planos no mesmo servidor,
 * "Teste 2h completo" com o link do robô e um "Novo pacote" sem nada. Ali deu
 * certo por acaso: o bom era o mais antigo. Invertida a ordem de criação, todo
 * teste passaria a chamar `…/api/chatbot/` sem os dois códigos secretos, o
 * painel devolveria erro, e a tela diria "o painel não respondeu" com o plano
 * certo configurado logo ao lado.
 *
 * Então a regra é: o primeiro que TEM COMO gerar. Sem nenhum, o primeiro
 * mesmo — para o erro continuar sendo sobre o plano que a pessoa vê primeiro,
 * e não sobre um que ela nem sabe que existe.
 *
 * ## A mesma regra mora na tela
 *
 * `src/utils/planoDoTeste.ts`, no repositório da interface, escolhe de qual
 * plano vem a lista de aplicativos. As duas PRECISAM concordar: divergindo,
 * quem atende escolhe um app do catálogo de um plano e recebe o código do
 * outro. Mudou aqui, muda lá. - 2026/08/22
 */
export type PlanoParaEscolher = {
  bot_url?: string | null;
  bot_path?: string | null;
};

export function escolherPacote<T extends PlanoParaEscolher>(
  lista: readonly T[] | null | undefined,
): T | undefined {
  const todos = lista ?? [];

  return (
    todos.find((p) => p.bot_url?.trim() || p.bot_path?.trim()) ?? todos[0]
  );
}
