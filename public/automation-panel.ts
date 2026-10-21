// #32 — painel da candidatura automática: kill-switch, limite diário, allowlist de ATS e a
// fila "Aguardando confirmação final" (captura + resumo dos campos + ENVIAR). Módulo separado
// de app.ts para manter o JS do dashboard em funções pequenas; app.ts injeta os utilitários.
import { atsFamilyFor } from "../src/ats-domains.js";

export type FieldSummary = { label: string; value: string };
export type AuthorizationView = {
  application_id: string; authorization_id: string; state: string; expires_at: string | null; claimed_by: string | null;
  final_confirmation_requested_at: string | null; final_confirmation_at: string | null; paused_at: string | null; ats: string | null;
};
export type FinalConfirmationView = {
  application_id: string; job_id: string; requested_at: string | null; expires_at: string | null; claimed_by: string | null;
  evidence_id: string | null; observed_url: string | null; fields_summary: FieldSummary[]; created_at: string | null;
};
export type AutomationOverview = {
  env_enabled: boolean; enabled: boolean; effective: boolean; daily_limit: number; per_ats_limit: number | null; ats_allowlist: string[];
  updated_at: string | null; updated_by: string | null; remaining_today: number; active_runs: number; issued_authorizations: number;
  usage: { date: string; time_zone: string; total: number; by_ats: Record<string, number> };
  authorizations: AuthorizationView[]; final_confirmations: FinalConfirmationView[];
};

export type PanelHelpers = {
  escapeHtml: (value: unknown) => string;
  formatDate: (value: string | null | undefined) => string;
};

export type ActionDeps = PanelHelpers & {
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

function statusPill(automation: AutomationOverview, h: PanelHelpers) {
  if (automation.effective) return `<span class="status-pill teal">Ligada</span>`;
  if (!automation.enabled) return `<span class="status-pill red">Pausada (kill-switch)</span>`;
  return `<span class="status-pill neutral">${h.escapeHtml("Desligada no servidor (RADAR_AUTO_APPLICATION_ENABLED)")}</span>`;
}

function finalConfirmationCard(item: FinalConfirmationView, jobLabel: string, h: PanelHelpers) {
  const fields = item.fields_summary.length
    ? `<dl class="summary-list final-fields">${item.fields_summary.map((field) => `<div><dt>${h.escapeHtml(field.label)}</dt><dd>${h.escapeHtml(field.value || "—")}</dd></div>`).join("")}</dl>`
    : `<p class="muted-text">O executor não enviou resumo dos campos.</p>`;
  const shot = item.evidence_id
    ? `<a href="${h.escapeHtml(evidenceUrl(item.application_id, item.evidence_id))}" target="_blank" rel="noopener noreferrer"><img class="final-shot" src="${h.escapeHtml(evidenceUrl(item.application_id, item.evidence_id))}" alt="${h.escapeHtml(`Captura da tela antes do envio: ${jobLabel}`)}" loading="lazy" /></a>`
    : `<p class="muted-text">Sem captura de tela.</p>`;
  return `<article class="final-confirmation"><div class="section-head flush"><div><h3>${h.escapeHtml(jobLabel)}</h3><p>${h.escapeHtml(`Pedido em ${h.formatDate(item.requested_at)} · executor ${item.claimed_by ?? "—"} · autorização expira em ${h.formatDate(item.expires_at)}`)}</p></div></div>
    <p class="muted-text">${h.escapeHtml(`Página observada: ${item.observed_url ?? "—"}`)}</p>
    <div class="final-confirmation-body">${shot}${fields}</div>
    <div class="button-row"><button class="primary-button" data-final-confirm="${h.escapeHtml(item.application_id)}" data-job-label="${h.escapeHtml(jobLabel)}">Enviar agora</button><button class="secondary-button" data-final-cancel="${h.escapeHtml(item.application_id)}">Cancelar envio</button></div></article>`;
}

/** Seção da página de operação. `jobLabel` resolve o nome da vaga de uma candidatura. */
export function automationPanel(automation: AutomationOverview | undefined, jobLabel: (applicationId: string, jobId: string) => string, h: PanelHelpers) {
  if (!automation) return "";
  const byAts = Object.entries(automation.usage.by_ats).map(([ats, count]) => `${ats}: ${count}`).join(" · ");
  const toggle = automation.enabled
    ? `<button class="danger-button" data-automation-toggle="off" data-active-runs="${h.escapeHtml(automation.active_runs)}">Pausar automação</button>`
    : `<button class="primary-button" data-automation-toggle="on">Religar automação</button>`;
  const confirmations = automation.final_confirmations.map((item) => finalConfirmationCard(item, jobLabel(item.application_id, item.job_id), h)).join("");
  return `<section class="panel section-spaced" aria-labelledby="automation-title"><div class="section-head flush"><div><h2 id="automation-title">Automação de candidaturas</h2><p>Envio automático só em ATS de empresa, sempre com sua confirmação final. LinkedIn e portais amplos ficam no envio manual.</p></div>${statusPill(automation, h)}</div>
    <div class="ops-list">
      <article class="ops-item"><div><strong>Kill-switch</strong><span>${h.escapeHtml(automation.enabled ? `${automation.active_runs} execução(ões) em andamento e ${automation.issued_authorizations} autorização(ões) emitida(s). Pausar manda as execuções para revisão e mantém as autorizações.` : "Pausada: nada é autorizado, reservado ou enviado até você religar.")}</span></div>${toggle}</article>
      <article class="ops-item"><div><strong>Envios de hoje</strong><span>${h.escapeHtml(`${automation.usage.total} de ${automation.daily_limit} (${automation.usage.date}, horário de São Paulo)${byAts ? ` · ${byAts}` : ""}`)}</span></div><span class="status-pill ${automation.remaining_today > 0 ? "teal" : "red"}">${h.escapeHtml(`${automation.remaining_today} restante(s)`)}</span></article>
    </div>
    <div class="form-grid section-spaced" data-automation-form>
      <div class="form-field"><label for="automation-daily-limit">Limite diário (todos os ATS)</label><input class="input" id="automation-daily-limit" name="daily_limit" type="number" min="0" max="100" step="1" value="${h.escapeHtml(automation.daily_limit)}" /></div>
      <div class="form-field"><label for="automation-per-ats">Limite diário por ATS</label><input class="input" id="automation-per-ats" name="per_ats_limit" type="number" min="0" max="100" step="1" value="${h.escapeHtml(automation.per_ats_limit ?? "")}" placeholder="sem limite" /></div>
      <div class="form-field full"><label for="automation-allowlist">ATS permitidos (um domínio por linha)</label><textarea class="input" id="automation-allowlist" name="ats_allowlist" rows="5" spellcheck="false">${h.escapeHtml(automation.ats_allowlist.join("\n"))}</textarea><small class="field-hint">Vale o domínio e seus subdomínios (ex.: greenhouse.io cobre boards.greenhouse.io).</small></div>
      <div class="button-row full"><button class="secondary-button" data-automation-save>Salvar limites e ATS</button></div>
    </div></section>
    <section class="panel section-spaced" aria-labelledby="final-confirmation-title"><div class="section-head flush"><div><h2 id="final-confirmation-title">Aguardando confirmação final</h2><p>O executor preencheu o formulário e parou antes do clique final. Confira a captura e os campos; o envio só acontece se você digitar ENVIAR.</p></div><span class="status-pill ${automation.final_confirmations.length ? "orange" : "neutral"}">${h.escapeHtml(automation.final_confirmations.length)}</span></div>
    <div class="ops-list">${confirmations || `<div class="empty-state"><div><strong>Nada aguardando</strong><span>Nenhuma candidatura automática está esperando sua confirmação.</span></div></div>`}</div></section>`;
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
