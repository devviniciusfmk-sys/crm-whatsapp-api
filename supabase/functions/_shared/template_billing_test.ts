import { assertEquals } from "jsr:@std/assert@1";
import { countryFromPhone } from "./template_billing.ts";

/**
 * O prefixo mais longo tem de ganhar.
 *
 * "1" (EUA) é prefixo de "351" (Portugal): varrer a lista na ordem em que ela
 * está escrita atribuiria a tarifa americana a um número português — e tarifa
 * errada é pior que tarifa ausente, porque ninguém vai conferir uma linha que
 * já tem número. Run with `deno test` from `supabase/functions`.
 */
Deno.test("país pelo prefixo: o mais longo ganha", () => {
  assertEquals(countryFromPhone("+351912345678"), "pt");
  assertEquals(countryFromPhone("+15550123456"), "us");
});

Deno.test("país pelo prefixo: formatos que aparecem no banco", () => {
  // Com e sem "+", com máscara, e o formato que o WhatsApp devolve.
  assertEquals(countryFromPhone("+55 11 91234-5678"), "br");
  assertEquals(countryFromPhone("5511912345678"), "br");
  assertEquals(countryFromPhone("+5491123456789"), "ar");
});

Deno.test("sem país conhecido, sem palpite", () => {
  // Um número que não sabemos precificar não recebe a tarifa do vizinho.
  assertEquals(countryFromPhone("+919812345678"), undefined);
  assertEquals(countryFromPhone(""), undefined);
  assertEquals(countryFromPhone(null), undefined);
  assertEquals(countryFromPhone(undefined), undefined);
});
