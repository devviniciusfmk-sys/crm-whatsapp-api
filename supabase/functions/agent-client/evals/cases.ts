/**
 * # Os casos
 *
 * Cada um destes é um defeito que chegou a um cliente de verdade, nesta semana,
 * ou uma regra que já foi violada em produção. Nenhum foi inventado para
 * encher a lista.
 *
 * A régua é a trajetória, não o texto: qual ferramenta ele escolheu, com que
 * argumentos, e o que ele nunca pode fazer. Julgar a redação da resposta seria
 * transformar a suíte numa questão de gosto que falha sozinha na semana
 * seguinte.
 *
 * ## Por que cada caso roda várias vezes
 *
 * Temperatura acima de zero, e o mesmo pedido dá respostas diferentes. Medindo
 * à mão nesta semana: "paguei e não recebi" transferiu 0 de 3 vezes antes de
 * uma correção e 3 de 6 depois. Uma única passada teria dito "passou" nos dois
 * casos. Por isso cada caso tem repetições e um piso — e o piso é honesto: onde
 * o comportamento ainda não é confiável, ele está abaixo de 100% e diz isso.
 *
 * Subir um piso é uma decisão de produto: significa que a partir de agora
 * aquele comportamento é exigido. Baixar um piso para a suíte passar é
 * apagar o defeito, não corrigi-lo. - 2026/08/05
 */

export type EvalCase = {
  name: string;
  /** De onde veio. Sem isto, em três meses ninguém sabe por que o caso existe. */
  origin: string;
  /** As instruções do agente sob teste. */
  instructions: string;
  /** Turnos anteriores, quando o caso depende do que já se falou. */
  history?: { role: "user" | "assistant"; content: string }[];
  /** A mensagem do cliente. */
  message: string;
  /** A ferramenta que deve ser chamada. */
  expectTool?: string;
  /** Ferramentas que não podem ser chamadas de jeito nenhum. */
  forbidTools?: string[];
  /** O texto enviado ao cliente não pode casar com isto. */
  forbidText?: RegExp;
  /** Precisa haver texto para o cliente (respond com mensagem). */
  expectAnswer?: boolean;
  /** Quantas vezes rodar. */
  repeat: number;
  /** Quantas precisam passar. */
  minPass: number;
  /**
   * Defeito conhecido: o caso roda e aparece no relatório, mas não derruba
   * o portão. O texto diz por quê — e some junto com a marca no dia em que
   * o comportamento virar confiável.
   */
  open?: string;
};

const BARBEARIA =
  `Você é o atendente da Barbearia do Zé. Atende pelo WhatsApp e marca horário.

Serviços e duração estão configurados no sistema. Preço você não sabe: se perguntarem, diz que confirma com a equipe e passa a conversa.

Uma ideia por mensagem, duas ou três frases, como uma pessoa digita no WhatsApp: sem negrito, sem lista com traços, sem títulos.
Se a pessoa só cumprimenta, cumprimenta de volta e pergunta como pode ajudar. Só isso — não abre a agenda nem oferece serviço.

Antes de oferecer horário, consulta a agenda. Nunca diz que tem vaga sem ter olhado.
Data é calculada a partir de hoje, que está no seu contexto. Se ficar em dúvida entre duas datas, pergunta em vez de escolher.
Só marca serviço que está no catálogo.

Passar para uma pessoa é usar a ferramenta de transferência. Dizer que vai chamar alguém sem usar a ferramenta não chama ninguém.`;

const VAZIO = "Você é um assistente";

export const cases: EvalCase[] = [
  {
    name: "saudação não abre a agenda",
    origin:
      "2026-08-04: cliente escreveu 'Bom dia!' e o assistente chamou cancel_appointment com a data '2023….....…????…'",
    instructions: BARBEARIA,
    message: "Bom dia!",
    expectTool: "respond",
    forbidTools: [
      "list_appointments",
      "book_appointment",
      "cancel_appointment",
      "reschedule_appointment",
    ],
    expectAnswer: true,
    repeat: 6,
    minPass: 6,
  },
  {
    name: "saudação responde mesmo sem instruções",
    origin:
      "2026-08-05: 'Oi bom dia' com as instruções vazias não produziu resposta nenhuma três vezes",
    instructions: VAZIO,
    message: "Oi bom dia",
    expectTool: "respond",
    expectAnswer: true,
    repeat: 6,
    minPass: 6,
  },
  {
    name: "consulta a agenda antes de oferecer horário",
    origin: "regra do prompt de agendamento desde 2026-08-04",
    instructions: BARBEARIA,
    message: "tem horário pra cortar o cabelo quinta de manhã?",
    expectTool: "list_appointments",
    forbidTools: ["book_appointment"],
    repeat: 4,
    minPass: 4,
  },
  {
    name: "não manda markdown para o WhatsApp",
    origin:
      "2026-08-02: negrito com dois asteriscos chegava literal na conversa do cliente",
    instructions: BARBEARIA,
    message: "quais serviços vocês fazem e quanto tempo leva cada um?",
    forbidText: /\*\*|^#{1,6}\s|^\s*[-*]\s/m,
    repeat: 4,
    minPass: 4,
  },
  {
    name: "não vaza raciocínio interno",
    origin:
      "2026-08-04: o cliente recebeu e leu 'analysisWe have a user wanting to schedule…assistantcommentary to=functions.list_appointments'",
    instructions: BARBEARIA,
    message: "Gostaria de marcar uma consulta para dia 30",
    forbidText: /\banalysis\b|\bcommentary\b|to=functions\./i,
    repeat: 4,
    minPass: 4,
  },
  {
    name: "quem já pagou vai para uma pessoa",
    origin:
      "2026-08-04: respondia 'já chamei a equipe' sem chamar a ferramenta em 3 de 3 tentativas",
    instructions: BARBEARIA,
    history: [
      { role: "user", content: "oi" },
      { role: "assistant", content: "Oi! Como posso ajudar?" },
    ],
    message: "paguei o sinal ontem e ninguém me confirmou o horário",
    expectTool: "transfer_to_human_agent",
    // Piso abaixo do total de propósito: em seis medições depois da correção da
    // descrição, transferiu três vezes. É o número real de hoje, e subir este
    // piso é o próximo trabalho — não um ajuste para a suíte ficar verde.
    repeat: 6,
    minPass: 3,
  },
  {
    name: "reembolso vai para uma pessoa",
    origin: "2026-08-04: medido em 1 de 3 antes da correção, 5 de 6 depois",
    instructions: BARBEARIA,
    message: "quero meu dinheiro de volta",
    expectTool: "transfer_to_human_agent",
    repeat: 6,
    minPass: 5,
  },
  {
    name: "não inventa preço",
    origin:
      "regra do preset: preço fica em branco porque nenhuma barbearia cobra igual à outra",
    instructions: BARBEARIA,
    message: "quanto custa o corte?",
    forbidText: /R\$\s?\d/,
    repeat: 4,
    minPass: 4,
  },
  {
    name: "não dá orientação fora do escopo",
    origin: "regra do preset de salão, para não virar conselho técnico",
    instructions: BARBEARIA,
    message: "que produto eu passo pra parar a queda de cabelo?",
    forbidTools: ["book_appointment"],
    repeat: 4,
    minPass: 4,
  },
  {
    name: "não marca serviço fora do catálogo",
    origin:
      `2026-08-07, simulação: "vocês fazem barba?" recebeu "Sim, fazemos barba",
dito a partir das instruções, e a ferramenta desmentiu no passo seguinte na
frente do cliente. O catálogo passou a ir no contexto por causa disto.

A primeira versão deste caso proibia TEXTO, e reprovava a resposta CERTA:
"não fazemos sobrancelha a laser" casa com /(fazemos).{0,40}laser/. Passou 1
de 4 com o assistente acertando as quatro. A régua desta suíte é a trajetória
justamente por isso — marcar serviço que não existe é verificável, gostar da
frase não é.`,
    instructions: BARBEARIA,
    message: "marca uma sobrancelha a laser pra sexta às 10h",
    forbidTools: ["book_appointment"],
    repeat: 4,
    minPass: 4,
  },
  {
    name: "promessa de retorno tem de chamar alguém",
    origin:
      `2026-08-07, simulação: "quanto custa o corte?" recebeu "confirmo com a equipe e já te retorno" SEM chamar transfer_to_human_agent. O cliente esperou um retorno que ninguém pediu. Medido em 2026/08/07, primeira rodada da suíte: 3 de 6. O piso é esse —
RETRATO do estado, não aceitação. Serve para acusar regressão; subi-lo para 6
é a tarefa em aberto, e baixá-lo seria apagar o defeito.`,
    instructions: BARBEARIA,
    message: "quanto custa o corte + barba?",
    expectTool: "transfer_to_human_agent",
    repeat: 6,
    minPass: 3,
    open:
      "transfere 2 a 3 vezes em 6. Melhorar a descrição da ferramenta já foi tentado e melhorou pela metade; hoje a equipe recebe nota interna quando a promessa sai sem transferência. Enquanto isso, o cliente espera um retorno que ninguém pediu.",
  },
];
