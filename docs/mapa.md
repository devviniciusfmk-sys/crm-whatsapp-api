# Mapa do projeto

Escrito porque a pergunta "onde fica X?" não tinha resposta curta, e a resposta
verdadeira — "depende, X mora em cinco lugares" — só é útil com o mapa junto.

O produto são dois repositórios:

- **`open-bsp-ui`** — o que o usuário vê. React, TanStack Router, Tailwind.
- **`crm-whatsapp-api`** — o que roda sozinho. Postgres e funções de borda no
  Supabase.

## A regra que explica a arrumação

**O projeto é organizado por camada técnica, não por assunto.** Não existe uma
pasta `agenda/` nem uma pasta `campanhas/`. Existe uma pasta de telas, uma de
consultas, uma de tabelas — e cada assunto atravessa todas.

Isso é normal e não vamos mudar: reorganizar por assunto quebraria todos os
imports do projeto em troca de uma sensação de ordem. O que faltava era o mapa.

### Um assunto, rastreado

A agenda, inteira, mora nestes lugares:

| o quê | onde |
|---|---|
| a tela do dia | `ui/src/routes/_auth/agenda.tsx` |
| o calendário do mês | `ui/src/components/MonthGrid.tsx` |
| configuração de serviços | `ui/src/components/AppointmentsSection.tsx` |
| configuração do lembrete | `ui/src/components/ReminderSection.tsx` |
| leitura e escrita | `ui/src/queries/useAppointments.ts` |
| a tabela | `api/supabase/schemas/03_models/03-13_appointments.sql` |
| o que o assistente sabe fazer | `api/supabase/functions/agent-client/tools/appointments.ts` |

Procure um assunto por essas sete linhas e você acha qualquer outro.

## A interface

```
src/routes/       as telas. O caminho do arquivo é a URL.
                  `_auth/` é tudo que exige estar logado.
src/components/   pedaços de tela reusáveis
src/queries/      tudo que fala com o banco (react-query)
src/stores/       o que fica em memória — conversas abertas, organização ativa
src/supabase/     os tipos. Cópia dos da API: ver "tipos" abaixo.
src/config/       constantes do produto — dados da empresa, modelos de negócio
src/hooks/        ganchos de React
src/i18n/         a busca de tradução
public/locales/   os dicionários: pt, en, fr, sw
scripts/          checagem de tradução, sincronia de tipos, tirador de tela
```

## O servidor

```
supabase/schemas/     O BANCO. É aqui que se edita.
   00_extensions      extensões do Postgres
   01_types           enums
   02_functions       funções e gatilhos
   03_models          tabelas
   04_functions_...   funções que dependem das tabelas existirem
   05_rls             quem pode ler e escrever o quê
   06_billing         planos, uso, cobrança

supabase/migrations/  o histórico do que já foi aplicado. Gerado, não escrito.
supabase/functions/   o que executa
   agent-client       o assistente: protocolos, ferramentas, o laço
   whatsapp-webhook   o que chega da Meta
   whatsapp-dispatcher o que sai para a Meta
   contact-memory     o resumo do cliente, por cron
   iptv               teste e ativação de quem revende painel de IPTV
   pagamentos         Pix e o retorno do gateway
   mcp                servidor de ferramentas para agentes externos
   media-preprocessor transcrição e descrição de áudio, imagem e vídeo
   storage-gc         limpeza de arquivos órfãos
docs/                 este mapa e os textos de referência
```

## Duas regras que evitam a maioria dos erros

**1. O banco se edita em `schemas/`, nunca em `migrations/`.**
A migração é gerada com `npx supabase db diff -f nome`, e sempre é podada à mão:
o gerador propõe 180 `revoke` sobre todas as tabelas e reescreve funções que só
diferem por fim de linha. Aplicar aquilo derruba o acesso do produto inteiro.
Cada migração deste repositório diz, no próprio arquivo, o que foi retirado e
por quê.

**2. Os tipos da UI são cópia dos da API.**
`ui/src/supabase/types/*` espelha `api/supabase/functions/_shared/types/*`. As
diferenças de propósito são marcadas com `// @ui-divergence:`. Rode
`npm run types:sync-check` para ver o que saiu de sincronia.

## Onde ficam os "módulos"

Não existe pasta de módulos, e é de propósito. Mas há **dois tipos**, e este
texto dizia que só existia o primeiro — até 2026/08/22, quando o segundo ficou
grande demais para continuar sem nome.

### 1. Módulo de RAMO: é um objeto de dados

Barbearia, salão, clínica. Não precisa de tela nova, tabela nova nem ferramenta
nova. Tudo o que ele define já é campo:

| o módulo define | o campo que já existe |
|---|---|
| serviços, duração, preço | `organizations.extra.appointments.services` |
| horário de atendimento | `organizations.extra.business_hours` |
| lembrete da véspera | `organizations.extra.appointment_reminder` |
| boas-vindas, fora de horário | `organizations.extra.welcome_message`, `away_message` |
| instruções do assistente | `agents.extra.instructions` |
| ferramentas ligadas | `agents.extra.tools` |
| links que ele pode mandar | `agents.extra.links` |

Então o módulo é **um objeto de dados**, e mora em um arquivo só:
`ui/src/config/businessPresets.ts`.

Acrescentar um ramo é escrever mais um objeto ali. Sem tela nova, sem migração.

### 2. Módulo de NEGÓCIO: é um vertical isolado

Cobrança por Pix e IPTV. Aqui a loja não só atende diferente — ela **fala com um
sistema de fora** que tem contas, credenciais e regras próprias. Isso não cabe
num campo, e forçar caberia significa espalhar a lógica de um provedor de
pagamento pelo código que manda mensagem.

O que os dois têm em comum, e é a regra deste tipo:

- **ligado por `organizations.extra.modules`**, um vetor de palavras. `temModulo`
  na interface, e o botão da barra só existe quando ela está lá. Uma barbearia
  nunca vê uma televisão no rodapé da conversa.
- **função de borda própria**, sem ligação com o assistente. O painel de IPTV
  fora do ar não pode parar o atendimento, que é o produto.
- **segredo no cofre**, nunca em coluna. Ver `02-05_vault_secrets.sql`: qualquer
  membro lê as linhas pela RLS, e o gatilho de webhook manda a linha inteira
  para fora.
- **tabelas próprias com prefixo**, `iptv_*`, e RLS que separa configuração
  (admin) de operação (membro).

O IPTV inteiro mora nestes lugares:

| o quê | onde |
|---|---|
| a tela do funil | `ui/src/routes/_auth/testes.tsx` + `components/TestesCenter.tsx` |
| a configuração | `ui/src/routes/_auth/integrations/iptv.tsx` + `components/IptvCenter.tsx` |
| o botão da conversa | `ui/src/components/ChatFooter.tsx`, procure `Tv` |
| leitura e escrita | `ui/src/queries/useIptv.ts`, `useFunilDoIptv.ts`, `useGerarTeste.ts` |
| as regras puras | `ui/src/utils/` — `menuDeApps`, `relogioDoTeste`, `quemSumiu`, `janelaDoFunil`, `planoDoTeste` |
| as tabelas | `api/supabase/schemas/03_models/03-30_iptv.sql` |
| a função de borda | `api/supabase/functions/iptv/` |
| a conversa com o painel | `api/supabase/functions/iptv/painel.ts` (Sigma API) |
| o teste de ponta a ponta | `ui/scripts/iptv-teste.mjs`, `converteu-teste.mjs` |

Acrescentar um vertical é caro. Antes de criar o terceiro, pergunte se ele não é
um campo. - 2026/08/22

## O caminho de quem chega

1. **Entrar** — `routes/login.tsx`, com senha ou OAuth. Não há auto-cadastro:
   a conta nasce de um convite ou do primeiro acesso.
2. **Criar a organização** — `routes/_auth/settings/organization/new.tsx`.
   Dois campos, nome e fuso, e um comentário no código explicando a escolha:
   sete linhas de horário no primeiro formulário que alguém vê é frição na pior
   hora. É aqui que o tipo de negócio entra — um select que preenche as sete.
3. **Conectar o WhatsApp** — `routes/_auth/integrations/whatsapp/`, pelo diálogo
   da Meta ou pelo caminho manual com token de usuário de sistema.
4. **Configurar o assistente** — `routes/_auth/agents/`.

## Onde procurar quando algo dá errado

| sintoma | onde olhar |
|---|---|
| o assistente não respondeu | a conversa tem uma mensagem interna dizendo o motivo, com os números da chamada |
| a mensagem não saiu | `whatsapp-dispatcher`, e a fila em `claim_pending_messages` |
| a mensagem não entrou | `whatsapp-webhook` |
| a tela mostra espanhol | falta a chave no dicionário: `npm run i18n:check` |
| o tipo não bate com o banco | `npm run types:sync-check` |
| o teste de IPTV não saiu | a resposta traz o motivo em `mensagem`, com status 200 — a tela mostra. Sem plano com link de robô, é 409 |
| a lista aparece vazia tendo linhas | junção sem chave estrangeira devolve `PGRST200`, e `data ?? []` engole. Sempre olhe o `error` |
| o cliente aparece como telefone | o nome vem de conversa → ficha → perfil. Ver `ui/src/utils/nomeDoCliente.ts` |
| o filtro da URL some sozinho | o router converte o que parece número: `?periodo=30` chega como 30, e `["30"].includes(30)` é falso |
| o assistente falou dentro de um grupo | não deveria: `agent-client/grupo.ts` cala antes de qualquer outra decisão. Se voltou a falar, a trava saiu do topo do `Deno.serve` |
| grupo não aparece na caixa de entrada | a API oficial da Meta não entrega grupo. Grupo só chega pela ponte `whatsapp-web`, e ela precisa de `WHATSAPP_WEB_URL` |
| um teste apagou o que outro plantou | dois `const PREFIXO` iguais em `ui/scripts/`. Um por suíte, nenhum repetido |
