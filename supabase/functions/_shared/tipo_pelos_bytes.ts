/**
 * # O tipo do arquivo lido dos BYTES
 *
 * `uploadToStorage` recebe um `Blob` de um multipart e o entrega ao Storage sem
 * `contentType`. Quando o conector monta o multipart em Go com
 * `CreateFormFile`, a parte vai carimbada como `application/octet-stream` — é o
 * padrão da biblioteca —, e é isso que fica gravado para sempre.
 *
 * Medido em 2026/08/23, na primeira noite da ponte não-oficial: seis arquivos
 * guardados, seis `application/octet-stream`, com o WhatsApp tendo dito
 * `video/mp4` e `audio/ogg` corretamente. O `<video>` da tela recusa um blob
 * assim, e a queixa chegou como "os vídeos não baixam".
 *
 * ## Pelos bytes, e não pelo que mandaram dizer
 *
 * O tipo declarado não está disponível aqui: a mídia sobe numa chamada e a
 * mensagem que a descreve chega em OUTRA, depois. Então não há o que copiar —
 * só há o arquivo.
 *
 * E é a fonte melhor de qualquer jeito. O projeto já tinha chegado nessa
 * conclusão do lado da tela, em `resolveAudioMimeType`, com o comentário
 * dizendo que `mime_type` "vem do navegador ou do provedor e pode estar vazio
 * ou errado". Os primeiros bytes de um arquivo não mentem sobre o que ele é.
 *
 * ## Só quando não há resposta melhor
 *
 * Se o blob já vem com um tipo específico, ele vence: quem enviou sabe mais que
 * uma tabela de assinaturas. Isto só entra quando o que veio é genérico.
 *
 * A lista cobre o que o WhatsApp de fato manda. O que não estiver aqui continua
 * genérico, como já era — nunca pior do que antes. - 2026/08/23
 */

type Assinatura = {
  tipo: string;
  /** Bytes esperados, com `null` onde qualquer valor serve. */
  magica: (number | null)[];
  deslocamento?: number;
  /** Confirmação num segundo ponto, para formatos com contêiner comum. */
  contem?: { texto: string; ate: number };
};

const ASSINATURAS: Assinatura[] = [
  /* Contêiner ISO-BMFF: mp4, m4a e mov compartilham o `ftyp`, então o que
   * separa os três é a marca logo depois. Sem essa segunda olhada, um áudio
   * .m4a viraria `video/mp4` e a tela tentaria desenhar um quadro. */
  {
    tipo: "video/mp4",
    magica: [null, null, null, null, 0x66, 0x74, 0x79, 0x70],
    contem: { texto: "M4A", ate: 32 },
  },
  { tipo: "image/jpeg", magica: [0xff, 0xd8, 0xff] },
  { tipo: "image/png", magica: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { tipo: "image/gif", magica: [0x47, 0x49, 0x46, 0x38] },
  /* RIFF é contêiner de webp e de wav — a marca do tipo vem no byte 8. */
  {
    tipo: "image/webp",
    magica: [0x52, 0x49, 0x46, 0x46],
    contem: { texto: "WEBP", ate: 16 },
  },
  {
    tipo: "audio/wav",
    magica: [0x52, 0x49, 0x46, 0x46],
    contem: { texto: "WAVE", ate: 16 },
  },
  /* Ogg carrega Opus e Vorbis; o WhatsApp manda Opus nas mensagens de voz, e o
   * `codecs=` importa para o navegador escolher o decodificador. */
  {
    tipo: "audio/ogg; codecs=opus",
    magica: [0x4f, 0x67, 0x67, 0x53],
    contem: { texto: "Opus", ate: 64 },
  },
  { tipo: "audio/ogg", magica: [0x4f, 0x67, 0x67, 0x53] },
  { tipo: "application/pdf", magica: [0x25, 0x50, 0x44, 0x46] },
  { tipo: "video/webm", magica: [0x1a, 0x45, 0xdf, 0xa3] },
  { tipo: "audio/mpeg", magica: [0x49, 0x44, 0x33] },
  { tipo: "audio/mpeg", magica: [0xff, 0xfb] },
];

const GENERICOS = new Set([
  "",
  "application/octet-stream",
  "binary/octet-stream",
  "text/plain;charset=utf-8",
  "text/plain; charset=utf-8",
]);

export const tipoEhGenerico = (tipo?: string | null) =>
  GENERICOS.has((tipo ?? "").trim().toLowerCase());

/** O que os primeiros bytes dizem que este arquivo é. */
export function tipoPelosBytes(bytes: Uint8Array): string | undefined {
  const texto = new TextDecoder("latin1").decode(bytes.subarray(0, 64));

  for (const assinatura of ASSINATURAS) {
    const inicio = assinatura.deslocamento ?? 0;

    const bate = assinatura.magica.every(
      (esperado, i) => esperado === null || bytes[inicio + i] === esperado,
    );

    if (!bate) continue;

    if (assinatura.contem) {
      const achou = texto
        .slice(0, assinatura.contem.ate)
        .includes(assinatura.contem.texto);

      /* `M4A` num contêiner ISO-BMFF diz que é ÁUDIO, e não vídeo: aqui a
       * presença DESQUALIFICA o palpite. Nas outras, a presença confirma. */
      if (assinatura.tipo === "video/mp4") {
        if (achou) return "audio/mp4";
      } else if (!achou) {
        continue;
      }
    }

    return assinatura.tipo;
  }

  return undefined;
}

/**
 * O tipo com que este arquivo deve ser guardado.
 *
 * `undefined` quando não se sabe — e aí o Storage decide como sempre decidiu.
 * Chutar um tipo errado é pior que não ter tipo: o navegador confia no rótulo,
 * e um rótulo errado ele não desmente.
 */
export function tipoParaGuardar(
  tipoDeclarado: string | undefined,
  bytes: Uint8Array,
): string | undefined {
  if (!tipoEhGenerico(tipoDeclarado)) return tipoDeclarado;

  return tipoPelosBytes(bytes);
}
