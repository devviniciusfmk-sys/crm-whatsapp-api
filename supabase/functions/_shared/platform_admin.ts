const ADMIN_EMAILS = (Deno.env.get("ADMIN_EMAILS") ?? "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

/**
 * A única autorização de operador da plataforma que existe hoje do lado do
 * servidor.
 *
 * O portão de `/admin/*` na UI (`src/routes/_auth/admin.tsx`) roda em
 * `beforeLoad` — client-side, decorativo. Ele impede o menu de aparecer para
 * quem não está na lista, mas qualquer chamada direta à API passa por ele sem
 * ser vista. Esta função é o que de fato tranca alguma coisa, e lê a MESMA
 * lista de e-mails que a UI lê de `VITE_ADMIN_EMAILS`, mantida sincronizada à
 * mão por enquanto: sem uma coluna "admin de verdade" no banco, é a mesma
 * saída de sempre neste código — um operador único resolvido por variável de
 * ambiente, como as credenciais do gateway de pagamento ou o
 * `WHATSAPP_PIN_SECRET`.
 *
 * Existe como checagem separada, e não como mais um papel dentro de
 * `requireRoles` (`whatsapp-management/index.ts`), porque a pergunta que ela
 * responde é outra. `requireRoles` prova que quem chama pertence à
 * organização X com o papel Y — uma linha em `agents`. A entrega de um número
 * comprado na loja faz chamadas privilegiadas à Graph API usando um token
 * permanente pré-guardado, EM NOME de uma organização da qual o operador que
 * clicou "Conectar" pode nem ser membro — não existe, e não deveria existir,
 * uma linha em `agents` para isso. A permissão não é "pertence a esta
 * organização"; é "opera a plataforma inteira, para qualquer organização".
 * `requireRoles` não tem como expressar essa frase. Esta função é essa outra
 * frase. - 2026/08/26
 */
export function isPlatformAdmin(email?: string | null): boolean {
  return !!email && ADMIN_EMAILS.includes(email.toLowerCase());
}
