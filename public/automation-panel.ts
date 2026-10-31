// #32 — candidatura automática: tipos da visão `automation` do bootstrap e as ações do painel
// (kill-switch, limites/allowlist, ENVIAR e cancelamento da confirmação final). A marcação do
// painel está em Preact (public/ui/components/automation-panel.tsx); aqui ficam só as ações,
// delegadas no #view por `data-*`, e app.ts injeta os utilitários.
import { atsFamilyFor } from "../src/ats-domains.js";

// Tipos da visão `automation` do bootstrap: contrato compartilhado com o servidor (TD-14).
import type { AutomationOverview } from "../src/bootstrap-payload.js";

export type { AuthorizationView, AutomationOverview, FieldSummary, FinalConfirmationView } from "../src/bootstrap-payload.js";

export type ActionDeps = {
  escapeHtml: (value: unknown) => string;
  fetchJson: <T>(url: string, options?: RequestInit) => Promise<T>;
  openDialog: (options: { title: string; body: string; confirmLabel: string; danger?: boolean; validate?: (form: HTMLFormElement) => string | null }) => Promise<FormData | null>;
  confirmDialog: (title: string, message: string, confirmLabel: string, danger?: boolean) => Promise<boolean>;
  reload: () => Promise<void>;
  toast: (message: string, error?: boolean) => void;
};

/** O link é de um ATS em que o envio automático é permitido? (mesma regra do servidor) */
export function isAutomaticAllowed(automation: AutomationOverview | undefined, url: string | null | undefined) {
  return Boolean(automation && url && atsFamilyFor(url, automation.ats_allowlist));
}

export function evidenceUrl(applicationId: string, evidenceId: string) {
  return `/api/applications/${encodeURIComponent(applicationId)}/evidence/${encodeURIComponent(evidenceId)}`;
}

/** Trata os botões do painel; devolve true quando a ação era deste módulo. */
export async function handleAutomationAction(target: HTMLElement, deps: ActionDeps): Promise<boolean> {
  const toggle = target.closest<HTMLElement>("[data-automation-toggle]");
  if (toggle) {
    const turnOff = toggle.dataset.automationToggle === "off";
    if (turnOff) {
      const runs = Number(toggle.dataset.activeRuns ?? 0);
      if (!await deps.confirmDialog("Pausar a candidatura automática?", `${runs} execução(ões) em andamento vão para revisão e nada será enviado até você religar. Autorizações emitidas continuam valendo até expirar.`, "Pausar", true)) return true;
    }
    const result = await deps.fetchJson<{ paused_runs?: number; resumed_runs?: number }>("/api/settings/automation", { method: "PUT", body: JSON.stringify({ enabled: !turnOff }) });
    await deps.reload();
    deps.toast(turnOff ? `Automação pausada (${result.paused_runs ?? 0} execução(ões) em revisão).` : `Automação religada (${result.resumed_runs ?? 0} execução(ões) retomada(s)).`);
    return true;
  }
  if (target.closest("[data-automation-save]")) {
    const form = target.closest<HTMLElement>("[data-automation-form]");
    const read = (name: string) => form?.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${name}"]`)?.value.trim() ?? "";
    const daily = Number(read("daily_limit"));
    const perAtsRaw = read("per_ats_limit");
    const perAts = perAtsRaw === "" ? null : Number(perAtsRaw);
    const allowlist = read("ats_allowlist").split(/[\s,]+/u).map((item) => item.trim()).filter(Boolean);
    if (!Number.isInteger(daily) || daily < 0 || daily > 100) throw new Error("O limite diário precisa ser um número inteiro de 0 a 100.");
    if (perAts !== null && (!Number.isInteger(perAts) || perAts < 0 || perAts > 100)) throw new Error("O limite por ATS precisa ser um número inteiro de 0 a 100 (ou vazio para sem limite).");
    await deps.fetchJson("/api/settings/automation", { method: "PUT", body: JSON.stringify({ daily_limit: daily, per_ats_limit: perAts, ats_allowlist: allowlist }) });
    await deps.reload();
    deps.toast("Limites e ATS permitidos salvos.");
    return true;
  }
  const confirm = target.closest<HTMLElement>("[data-final-confirm]");
  if (confirm?.dataset.finalConfirm) {
    const applicationId = confirm.dataset.finalConfirm;
    const result = await deps.openDialog({
      title: "Enviar candidatura agora?",
      confirmLabel: "Enviar agora",
      danger: true,
      body: `<p>${deps.escapeHtml(`O executor vai clicar em enviar no portal para “${confirm.dataset.jobLabel ?? "esta vaga"}”. Isso não pode ser desfeito.`)}</p><div class="form-field"><label for="final-confirmation-text">Digite ENVIAR para confirmar</label><input class="input" id="final-confirmation-text" name="confirmation" required autocomplete="off" pattern="ENVIAR" data-message="Digite ENVIAR, em maiúsculas, para confirmar." /></div>`,
    });
    if (!result) return true;
    await deps.fetchJson(`/api/applications/${encodeURIComponent(applicationId)}/confirm-final`, { method: "POST", body: JSON.stringify({ confirmation: String(result.get("confirmation") ?? "") }) });
    await deps.reload();
    deps.toast("Envio confirmado. O executor vai concluir a candidatura.");
    return true;
  }
  const cancel = target.closest<HTMLElement>("[data-final-cancel]");
  if (cancel?.dataset.finalCancel) {
    if (!await deps.confirmDialog("Cancelar o envio automático?", "A autorização desta candidatura é revogada e ela volta para sua revisão. Você pode enviar manualmente ou autorizar de novo.", "Cancelar envio", true)) return true;
    await deps.fetchJson(`/api/applications/${encodeURIComponent(cancel.dataset.finalCancel)}/cancel-final`, { method: "POST" });
    await deps.reload();
    deps.toast("Envio automático cancelado; a candidatura voltou para revisão.");
    return true;
  }
  return false;
}
