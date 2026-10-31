// Hashes compartilhados (TD-11): uma única implementação para o núcleo (src/db/), o executor, a
// importação de JSON Resume e o servidor MCP. Sem estado e sem acesso ao banco.
import { createHash } from "node:crypto";
import { canonicalizeJobUrl } from "./domain.js";

/** SHA-256 em hexadecimal (texto em UTF-8 ou bytes). */
export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Hash da URL canônica (mesma regra de `canonicalizeJobUrl`): o que a autorização guarda e o executor confere. */
export function urlHash(url: string): string {
  return sha256Hex(canonicalizeJobUrl(url));
}

/** Id determinístico curto (18 hex) derivado de uma chave: linhas do núcleo, conectores e migrações. */
export function idFor(value: string): string {
  return sha256Hex(value).slice(0, 18);
}
