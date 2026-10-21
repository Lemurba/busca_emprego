/**
 * #32 — painel da candidatura automática em Preact (antes `automationPanel()` em string, em
 * public/automation-panel.ts): kill-switch, limite diário, allowlist de ATS e a fila
 * "Aguardando confirmação final" (captura + resumo dos campos + ENVIAR).
 *
 * Só marcação: os botões mantêm os mesmos `data-*` e continuam tratados por
 * `handleAutomationAction` (public/automation-panel.ts), delegado no #view. As confirmações
 * perigosas (pausar o kill-switch, digitar ENVIAR, cancelar o envio) vivem lá, sem mudança.
 */
import type { AutomationOverview } from "../../automation-panel.js";

type FormatDate = (value: string | null | undefined) => string;

const authorizationStateLabels: Record<string, string> = { issued: "Emitida", claimed: "Reservada", consumed: "Usada", revoked: "Revogada", expired: "Expirada" };

/** Texto da célula "Autorização" da tabela de candidaturas: estado, validade e quem reservou. */
export function authorizationText(automation: AutomationOverview | undefined, applicationId: string, formatDate: FormatDate) {
  const row = automation?.authorizations.find((item) => item.application_id === applicationId);
  if (!row) return "—";
  const parts = [authorizationStateLabels[row.state] ?? row.state];
  if (row.paused_at) parts.push("pausada");
  if (row.expires_at && ["issued", "claimed"].includes(row.state)) parts.push(`expira em ${formatDate(row.expires_at)}`);
  if (row.claimed_by) parts.push(`por ${row.claimed_by}`);
  return parts.join(" · ");
}
