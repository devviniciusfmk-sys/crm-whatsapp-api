# Revisão do app na Meta

O que precisa acontecer para que **um cliente seu** consiga conectar o WhatsApp
dele, e não só você.

Escrito a partir do que este código faz de fato — as telas citadas existem e os
caminhos são reais. O painel da Meta muda de nome com frequência; os menus aqui
são o lugar onde as coisas estavam, não uma promessa de que o rótulo é esse
hoje.

## O problema em uma frase

Enquanto o app está em **modo de desenvolvimento**, o "Continuar com Facebook"
só funciona para quem tem papel no app: administrador, desenvolvedor ou
testador. Você tem. Seu cliente não. Ele abre o convite, clica no botão, e a
Meta barra o login.

Isso vale para os dois caminhos que passam pelo diálogo:

- **Integrações → WhatsApp → Conectar número** (você conecta, com o Facebook do
  cliente na sua frente)
- **Integrações → WhatsApp → Convites a terceiros** (o cliente conecta sozinho)

O terceiro caminho, **Conectar sem Facebook**, não usa o diálogo — mas exige que
o cliente adicione o seu app ao portfólio comercial dele, o que a Meta também
condiciona ao nível de acesso do app. Não é um desvio da revisão; é um desvio do
popup.

## Antes de submeter

Sem isto a submissão nem abre, ou volta recusada sem análise:

1. **Portfólio comercial verificado** (Business Verification). É documento de
   empresa, e demora — comece por aqui.
2. **App vinculado a esse portfólio.**
3. **Política de privacidade publicada, com URL própria.** Obrigatória.
   Existe em `/privacidade` (e os termos em `/termos`), públicas, sem login.
   Os dados da empresa vêm das variáveis `VITE_COMPANY_*` — precisam estar
   definidas no servidor, senão a página abre com um aviso de documento
   incompleto. Falta a revisão jurídica antes de publicar.
4. **Termos de serviço**, mesma coisa, na prática sempre pedidos.
5. **Ícone, categoria e e-mail de contato** preenchidos no app.
6. **Data Use Checkup**, quando a Meta pedir. Ele vence de tempos em tempos e
   derruba o acesso avançado se ficar sem resposta — não é só uma etapa
   inicial.

## As permissões

App Review → Permissions and Features → pedir **acesso avançado** para:

| Permissão | Para que este produto usa |
|---|---|
| `whatsapp_business_management` | Conectar números, ler e criar modelos, ler e editar o perfil da empresa, ler qualidade do número e estatísticas de conversas |
| `whatsapp_business_messaging` | Receber as mensagens dos clientes e responder |

O texto de justificativa que o projeto original usou está no
[README](../README.md#allowed-usage) e serve de base:

- **management** — "Solicitamos esta permissão para ler e/ou gerenciar ativos de
  negócio do WhatsApp que possuímos ou aos quais outras empresas nos deram
  acesso."
- **messaging** — "Solicitamos esta permissão para ver, gerenciar e responder
  mensagens."

## Os vídeos

A Meta pede uma gravação de tela mostrando o uso real de cada permissão. O
README traz as gravações do projeto original.

**Grave as suas.** Não é preciosismo: o revisor está avaliando o *seu* app, com
a sua marca e o seu domínio na tela, e um vídeo de outra instalação é uma
resposta sobre outra coisa. Além disso as suas telas já estão em português e
mostram o produto como o seu cliente vai ver.

Grave com uma conta de teste, sem dados de cliente real na tela.

### Vídeo 1 — `whatsapp_business_management`

Um take só, sem cortes, mostrando o ciclo inteiro:

1. Entrar no sistema.
2. **Integrações → WhatsApp → Conectar número** — o diálogo da Meta abrindo e o
   número aparecendo conectado ao final.
3. Abrir o número → **Modelos de mensagens**: a lista carregada, e criar um
   modelo novo (o gerador por descrição serve, e mostra bem para que a
   permissão é usada).
4. Abrir o número → **Perfil da empresa**: mostrar os dados vindos da Meta e
   salvar uma alteração.
5. **Estatísticas → Saúde do número**: qualidade e limite lidos da conta.

### Vídeo 2 — `whatsapp_business_messaging`

1. Mandar uma mensagem de um celular para o número conectado.
2. Mostrar a conversa aparecendo na tela de **Conversas**.
3. Responder pelo sistema.
4. Mostrar a mensagem chegando no celular.

Os dois lados na mesma gravação. É isso que prova recebimento *e* envio.

## A ordem

1. Verificação do negócio (a mais demorada).
2. Política de privacidade e termos publicados.
3. Gravar os dois vídeos.
4. App Review → Permissions and Features → acesso avançado nas duas permissões.
5. App Review → Requests → **Next**, preencher justificativa e anexar os vídeos.
6. Esperar. Recusa costuma vir com o motivo; quase sempre é vídeo que não mostra
   o fluxo inteiro ou justificativa genérica.
7. Aprovado: passar o app para **Live**.

## Enquanto não sai

**O convite funciona hoje para testadores.** Adicione a pessoa como testador do
app no painel da Meta e o link passa a funcionar para ela. Dá para rodar um
piloto com um cliente próximo antes da aprovação — e é o melhor jeito de
descobrir os problemas do fluxo com tempo de sobra.

## Como saber onde você está

No painel da Meta:

- No topo do app: **Development** ou **Live**.
- App Review → Permissions and Features: cada permissão diz **Standard Access**
  ou **Advanced Access**. Standard = só quem tem papel no app.

Estas duas linhas respondem "o convite vai funcionar para o meu cliente?" sem
depender de tentar e ver falhar.
