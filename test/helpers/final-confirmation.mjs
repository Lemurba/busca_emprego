/**
 * Apoio ao protocolo do executor (#32): dry-run com captura PNG, confirmação humana (ENVIAR)
 * e token de envio de uso único.
 */

/** PNG 1×1 válido (assinatura + IHDR + IDAT + IEND) em base64. */
export const TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

export const FIELDS_SUMMARY = [
  { label: "Nome", value: "Pessoa Exemplo" },
  { label: "E-mail", value: "pessoa@example.test" },
  { label: "Currículo", value: "cv-aprovado.pdf" },
];

/** ATS permitido (allowlist padrão) para os fixtures. */
export const atsUrl = (slug) => `https://boards.greenhouse.io/exemplo/jobs/${slug}`;

/**
 * Executa o passo de dry-run no núcleo (src/db.ts) e devolve o token de envio:
 * requestFinalConfirmation → confirmFinalSubmission (ENVIAR) → pollFinalConfirmation.
 */
export function confirmFinal(store, applicationId, workerId, observedUrl) {
  store.requestFinalConfirmation(applicationId, { worker_id: workerId, observed_url: observedUrl, fields_summary: FIELDS_SUMMARY, screenshot_base64: TINY_PNG_BASE64 });
  store.confirmFinalSubmission(applicationId, "ENVIAR", "test-user");
  const polled = store.pollFinalConfirmation(applicationId, workerId);
  if (polled.status !== "confirmed" || !polled.submit_token) throw new Error(`confirmação final não entregou token: ${JSON.stringify(polled)}`);
  return polled.submit_token;
}
