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

Não existe pasta de módulos, e é de propósito.

Um módulo de ramo — barbearia, salão, clínica — não precisa de tela nova, tabela
nova nem ferramenta nova. Tudo o que ele define já é campo:

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
