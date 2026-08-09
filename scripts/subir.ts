/**
 * Subir função para produção — com portão, não com lembrete.
 *
 * Em 2026/08/09 eu subi duas vezes com a suíte vermelha. As duas por encadear
 * `deno task check && supabase functions deploy` numa linha só e o `&&` ligar
 * no `tail` em vez de ligar no resultado do teste. Nenhuma das duas foi
 * descuido de leitura: foram descuido de SHELL, que é o tipo que se repete
 * porque não depende de atenção.
 *
 * Um comando que roda o portão e só então sobe resolve isso de vez. A pessoa
 * — ou o assistente — não precisa lembrar de conferir; não tem como não
 * conferir.
 *
 * Rápido de propósito: tipos e testes unitários levam segundos, e é isso que
 * cabe antes de CADA subida. As suítes de ponta a ponta levam vinte minutos e
 * moram noutro comando (`npm run test:tudo`, no repositório da UI), para o dia
 * em que se fecha um trabalho — não a cada linha mexida.
 *
 *   deno task deploy                 sobe agent-client
 *   deno task deploy whatsapp-management  sobe outra
 *   deno task deploy --sem-portao    só em emergência, e ele avisa alto
 *
 * - 2026/08/09
 */

const args = Deno.args.filter((a) => a !== "--sem-portao");
const semPortao = Deno.args.includes("--sem-portao");
const funcao = args[0] ?? "agent-client";

const raiz = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

async function rodar(cmd: string, argumentos: string[], cwd: string) {
  const processo = new Deno.Command(cmd, {
    args: argumentos,
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  });

  const { code } = await processo.output();

  return code;
}

if (semPortao) {
  console.warn(
    "\n⚠  SUBINDO SEM PORTÃO. Os tipos e os testes não foram conferidos.\n",
  );
} else {
  console.log("→ tipos e testes unitários\n");

  const portao = await rodar("deno", [
    "task",
    "check",
  ], `${raiz}/supabase/functions`);

  if (portao !== 0) {
    console.error(
      "\n✗ O portão fechou: nada foi para produção.\n" +
        "  Conserte o que está vermelho e rode de novo.\n",
    );

    Deno.exit(portao);
  }

  console.log("\n✓ portão verde\n");
}

console.log(`→ subindo ${funcao}\n`);

const subida = await rodar("supabase", [
  "functions",
  "deploy",
  funcao,
], raiz);

Deno.exit(subida);
