import type { SupabaseClient } from "@supabase/supabase-js";
import { getWhatsAppAccessToken } from "./whatsapp_token.ts";

/**
 * Os modelos aprovados de um número, lidos direto da Meta.
 *
 * ## Por que não chamar a função que já lista modelos
 *
 * `whatsapp-management/templates` existe e faz isso — mas exige JWT de USUÁRIO
 * ou chave de API, e o agent-client fala com a chave de serviço. A chave de
 * serviço também começa com "eyJ", então ela entra pelo ramo do JWT, o
 * `auth.getUser()` não devolve ninguém, e o endpoint responde 401.
 *
 * O pior é como isso aparece: `functions.invoke` devolve erro, quem chama lê
 * `data` como nulo, e a lista sai VAZIA. Nenhum estouro, nenhum log do lado de
 * cá — só "esta loja não tem modelo aprovado" sobre uma loja que tem. Foi
 * exatamente o que a medição de 2026/08/13 mostrou: o retorno para a semana
 * seguinte continuava recusado com o modelo já aprovado.
 *
 * Aqui a leitura é direta, com as mesmas credenciais que o disparo já usa. Sem
 * salto de rede a mais, e sem uma porta de autenticação que não foi feita para
 * quem está do lado de dentro. - 2026/08/13
 */

const API_VERSION = "v21.0";

export type ApprovedTemplate = {
  name: string;
  language: string;
  category: string;
  body: string;
};

export async function approvedTemplates(
  client: SupabaseClient,
  organizationId: string,
  organizationAddress: string,
): Promise<ApprovedTemplate[]> {
  const { data } = await client
    .from("organizations_addresses")
    .select("extra->>waba_id")
    .eq("organization_id", organizationId)
    .eq("address", organizationAddress)
    .single();

  const wabaId = (data as { waba_id?: string } | null)?.waba_id;

  if (!wabaId) return [];

  const token = await getWhatsAppAccessToken(
    client,
    organizationId,
    organizationAddress,
  );

  if (!token) return [];

  const resposta = await fetch(
    `https://graph.facebook.com/${API_VERSION}/${wabaId}/message_templates?limit=100`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (!resposta.ok) return [];

  const corpo = await resposta.json() as {
    data?: {
      name: string;
      status: string;
      language: string;
      category: string;
      components?: { type: string; text?: string }[];
    }[];
  };

  return (corpo.data ?? [])
    .filter((item) => item.status === "APPROVED")
    .map((item) => ({
      name: item.name,
      language: item.language,
      category: item.category,
      body: item.components?.find((c) => c.type === "BODY")?.text ?? "",
    }));
}
