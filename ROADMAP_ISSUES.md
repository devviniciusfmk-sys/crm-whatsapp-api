# Roadmap → GitHub Issues

Conteúdo pronto para virar issues no repositório `crm-whatsapp-api`. Duas formas
de criar:

- **Manual:** copie cada bloco como uma issue nova, atribua a milestone e as
  labels.
- **Automatizado (recomendado, e você aprende o MCP):** com o GitHub MCP
  conectado no Claude Code, diga: _"Usando o GitHub MCP, crie no repo
  `SEU_USUARIO/crm-whatsapp-api` as milestones e issues descritas neste arquivo,
  respeitando milestone e labels."_ e anexe este arquivo.

---

## Labels sugeridas (crie uma vez)

| Label      | Cor      | Uso                            |
| ---------- | -------- | ------------------------------ |
| `backend`  | azul     | fork Supabase / edge functions |
| `frontend` | roxo     | CRM no Lovable                 |
| `infra`    | cinza    | repositórios, deploy, MCP, CI  |
| `security` | vermelho | correções de segurança         |
| `whatsapp` | verde    | integração Cloud API / Meta    |
| `docs`     | amarelo  | documentação                   |
| `learning` | rosa     | tarefa com objetivo didático   |

---

## Milestones (as 8 fases da auditoria)

- **Fase 0 — Fundação do fluxo de trabalho**
- **Fase 1 — Fundação técnica**
- **Fase 2 — WhatsApp Oficial**
- **Fase 3 — Inbox**
- **Fase 4 — CRM**
- **Fase 5 — Campanhas**
- **Fase 6 — Multi-tenant (produtização)**
- **Fase 7 — Relatórios**
- **Fase 8 — IA**

> Detalhamos abaixo apenas as Fases 0 e 1. As demais entram como milestone vazia
> agora e ganham issues quando estivermos a ~1 fase de distância.

---

# FASE 0 — Fundação do fluxo de trabalho

### #1 Aprovar auditoria e definir estrutura de repositórios

**Labels:** `docs`, `learning` **Descrição:** Revisar o
`AUDITORIA_CRM_WHATSAPP.md`, confirmar a decisão B (fork + estender) e a escolha
de repositórios separados. **Critério de conclusão:**

- [ ] Auditoria lida e aprovada
- [ ] Decisão de repos separados registrada no README do projeto

### #2 Criar fork do open-bsp-api

**Labels:** `infra`, `backend` **Descrição:** Fork de
`matiasbattocchia/open-bsp-api` → renomear para `crm-whatsapp-api`. Manter o
remote `upstream` apontando para o original (para puxar correções depois).
**Critério de conclusão:**

- [ ] Fork criado e clonado localmente
- [ ] `git remote -v` mostra `origin` (seu fork) e `upstream` (original)

### #3 Criar Project board do roadmap

**Labels:** `infra` **Descrição:** GitHub Project no repo, colunas: Backlog · A
fazer · Fazendo · Revisão · Concluído. **Critério de conclusão:**

- [ ] Board criado
- [ ] Milestones (Fases 0–8) cadastradas

### #4 Conectar GitHub MCP ao Claude Code

**Labels:** `infra`, `learning` **Descrição:**
`claude mcp add --transport http github https://api.githubcopilot.com/mcp` e
autenticar via `/mcp`. Testar com "liste minhas issues abertas". **Critério de
conclusão:**

- [ ] MCP conectado (aparece em `claude mcp list`)
- [ ] Claude Code consegue ler e criar uma issue de teste

### #5 Popular o board com as issues das Fases 0 e 1

**Labels:** `infra` **Descrição:** Criar todas as issues deste arquivo, manual
ou via MCP. **Critério de conclusão:**

- [ ] Todas as issues das Fases 0 e 1 no board, na coluna Backlog

---

# FASE 1 — Fundação técnica

### #6 Criar projeto Supabase (região São Paulo)

**Labels:** `infra`, `backend` **Descrição:** Novo projeto Supabase em
`sa-east-1` (LGPD). Guardar as chaves com segurança. **Critério de conclusão:**

- [ ] Projeto criado em São Paulo
- [ ] Chaves anotadas em gerenciador de segredos (não no repo)

### #7 Conectar fork ao Supabase e fazer primeiro deploy

**Labels:** `infra`, `backend` **Descrição:** Supabase GitHub Integration →
working directory `.`, branch `main`, criar o vault secret de deploy, disparar o
primeiro release. **Critério de conclusão:**

- [ ] Migrations aplicadas automaticamente no push
- [ ] Edge Functions deployadas
- [ ] `organizations` e demais tabelas existem no banco

### #8 Remover canais fora de escopo

**Labels:** `backend` **Descrição:** Não deployar / remover do fork:
`instagram-*`, `whatsapp-web-management`, e (por ora) `agent-client`, `mcp`,
`media-preprocessor`. Decidir sobre `06_billing`. **Critério de conclusão:**

- [ ] Funções fora de escopo removidas do fork
- [ ] `deno check` e CI continuam passando

### #9 [SEGURANÇA] Mover tokens Meta para o Vault

**Labels:** `security`, `backend` **Descrição:** Tirar `access_token` de
`organizations_addresses.extra` (texto puro, legível por qualquer membro via
RLS) e mover para Supabase Vault, ou mascarar o campo na leitura de não-admins.
Ver risco 🔴 CRÍTICO da auditoria. **Critério de conclusão:**

- [ ] Token não mais legível por SELECT de um `member`
- [ ] Dispatcher e management continuam enviando mensagens

### #10 [SEGURANÇA] Hash das API keys

**Labels:** `security`, `backend` **Descrição:** Armazenar hash em
`api_keys.key`; ajustar `get_authorized_orgs` para comparar por hash. **Critério
de conclusão:**

- [ ] Chaves persistidas como hash
- [ ] Autenticação por API key ainda funciona

### #11 Teste ponta a ponta com número de teste da Meta

**Labels:** `whatsapp`, `backend`, `learning` **Descrição:** App Meta em modo
dev, número de teste, enviar e receber uma mensagem pela Cloud API. Validar RLS
criando 2 organizações e confirmando isolamento. **Critério de conclusão:**

- [ ] Mensagem enviada e recebida com sucesso
- [ ] Org A não enxerga dados da Org B (RLS validado)
