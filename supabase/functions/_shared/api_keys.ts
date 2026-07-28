// api_keys stores sha256(key) hex-encoded, never the key itself. This mirrors
// public.hash_api_key() in Postgres — the two must stay in sync, since a lookup
// hashes here and compares against the column (and against the RLS policy,
// which hashes the `api-key` header the same way).
export async function hashApiKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(key),
  );

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
