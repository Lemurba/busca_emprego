/**
 * #32 — painel da candidatura automática em Preact (antes `automationPanel()` em string, em
 * public/automation-panel.ts): kill-switch, limite diário, allowlist de ATS e a fila
 * "Aguardando confirmação final" (captura + resumo dos campos + ENVIAR).
 *
 * Só marcação: os botões mantêm os mesmos `data-*` e continuam tratados por
 * `handleAutomationAction` (public/automation-panel.ts), delegado no #view. As confirmações
 * perigosas (pausar o kill-switch, digitar ENVIAR, cancelar o envio) vivem lá, sem mudança.
 */
import { type AutomationOverview, type FinalConfirmationView, evidenceUrl } from "../../automation-panel.js";
import { EmptyState } from "./empty-state.js";
import { countLabel } from "../plural.js";

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

function StatusPill({ automation }: { automation: AutomationOverview }) {
  if (automation.effective) return <span class="status-pill teal">Ligada</span>;
  if (!automation.enabled) return <span class="status-pill red">Pausada (kill-switch)</span>;
  // QAF-06: pílula curta (não quebra linha); o nome da variável vai no title e no texto do painel.
  return <span class="status-pill neutral" title="RADAR_AUTO_APPLICATION_ENABLED não está ligada no servidor">Desligada no servidor</span>;
}

function FinalConfirmationCard({ item, jobLabel, formatDate }: { item: FinalConfirmationView; jobLabel: string; formatDate: FormatDate }) {
  const shotUrl = item.evidence_id ? evidenceUrl(item.application_id, item.evidence_id) : null;
  return (
    <article class="final-confirmation">
      <div class="section-head flush"><div><h3>{jobLabel}</h3><p>{`Pedido em ${formatDate(item.requested_at)} · executor ${item.claimed_by ?? "—"} · autorização expira em ${formatDate(item.expires_at)}`}</p></div></div>
      <p class="muted-text">{`Página observada: ${item.observed_url ?? "—"}`}</p>
      <div class="final-confirmation-body">
        {shotUrl
          ? <a href={shotUrl} target="_blank" rel="noopener noreferrer"><img class="final-shot" src={shotUrl} alt={`Captura da tela antes do envio: ${jobLabel}`} loading="lazy" /></a>
          : <p class="muted-text">Sem captura de tela.</p>}
        {item.fields_summary.length
          ? <dl class="summary-list final-fields">{item.fields_summary.map((field, index) => <div key={index}><dt>{field.label}</dt><dd>{field.value || "—"}</dd></div>)}</dl>
          : <p class="muted-text">O executor não enviou resumo dos campos.</p>}
      </div>
      <div class="button-row">
        <button type="button" class="primary-button" data-final-confirm={item.application_id} data-job-label={jobLabel}>Enviar agora</button>
        <button type="button" class="secondary-button" data-final-cancel={item.application_id}>Cancelar envio</button>
      </div>
    </article>
  );
}

/** Seções da página de operação. `jobLabel` resolve o nome da vaga de uma candidatura. */
export function AutomationPanel({ automation, jobLabel, formatDate }: {
  automation: AutomationOverview | undefined;
  jobLabel: (applicationId: string, jobId: string) => string;
  formatDate: FormatDate;
}) {
  if (!automation) return null;
  const byAts = Object.entries(automation.usage.by_ats).map(([ats, count]) => `${ats}: ${count}`).join(" · ");
  const pending = automation.final_confirmations;
  return (
    <>
      <section class="panel section-spaced" aria-labelledby="automation-title">
        <div class="section-head flush">
          <div><h2 id="automation-title">Automação de candidaturas</h2><p>Envio automático só em ATS de empresa, sempre com sua confirmação final. LinkedIn e portais amplos ficam no envio manual.</p></div>
          <StatusPill automation={automation} />
        </div>
        {!automation.effective && automation.enabled
          ? <p class="muted-text automation-server-note">Para ligar, defina <code>RADAR_AUTO_APPLICATION_ENABLED=true</code> no servidor e reinicie o serviço.</p>
          : null}
        <div class="ops-list">
          <article class="ops-item">
            <div><strong>Kill-switch</strong><span>{automation.enabled ? `${countLabel(automation.active_runs, "execução", "execuções")} em andamento e ${countLabel(automation.issued_authorizations, "autorização emitida", "autorizações emitidas")}. Pausar manda as execuções para revisão e mantém as autorizações.` : "Pausada: nada é autorizado, reservado ou enviado até você religar."}</span></div>
            {automation.enabled
              ? <button type="button" class="danger-button" data-automation-toggle="off" data-active-runs={String(automation.active_runs)}>Pausar automação</button>
              : <button type="button" class="primary-button" data-automation-toggle="on">Religar automação</button>}
          </article>
          <article class="ops-item">
            <div><strong>Envios de hoje</strong><span>{`${automation.usage.total} de ${automation.daily_limit} (${automation.usage.date}, horário de São Paulo)${byAts ? ` · ${byAts}` : ""}`}</span></div>
            <span class={`status-pill ${automation.remaining_today > 0 ? "teal" : "red"}`}>{countLabel(automation.remaining_today, "restante", "restantes")}</span>
          </article>
        </div>
        {/* Campos lidos por `handleAutomationAction` pelo `name` dentro de [data-automation-form]. */}
        <div class="form-grid section-spaced" data-automation-form>
          <div class="form-field"><label for="automation-daily-limit">Limite diário (todos os ATS)</label><input class="input" id="automation-daily-limit" name="daily_limit" type="number" min="0" max="100" step="1" value={String(automation.daily_limit)} /></div>
          <div class="form-field"><label for="automation-per-ats">Limite diário por ATS</label><input class="input" id="automation-per-ats" name="per_ats_limit" type="number" min="0" max="100" step="1" value={automation.per_ats_limit == null ? "" : String(automation.per_ats_limit)} placeholder="sem limite" /></div>
          <div class="form-field full"><label for="automation-allowlist">ATS permitidos (um domínio por linha)</label><textarea class="input" id="automation-allowlist" name="ats_allowlist" rows={5} spellcheck={false} value={automation.ats_allowlist.join("\n")} /><small class="field-hint">Vale o domínio e seus subdomínios (ex.: greenhouse.io cobre boards.greenhouse.io).</small></div>
          <div class="button-row full"><button type="button" class="secondary-button" data-automation-save>Salvar limites e ATS</button></div>
        </div>
      </section>
      <section class="panel section-spaced" aria-labelledby="final-confirmation-title">
        <div class="section-head flush">
          <div><h2 id="final-confirmation-title">Aguardando confirmação final</h2><p>O executor preencheu o formulário e parou antes do clique final. Confira a captura e os campos; o envio só acontece se você digitar ENVIAR.</p></div>
          <span class={`status-pill ${pending.length ? "orange" : "neutral"}`}>{pending.length}</span>
        </div>
        <div class="ops-list">
          {pending.length
            ? pending.map((item) => <FinalConfirmationCard key={item.application_id} item={item} jobLabel={jobLabel(item.application_id, item.job_id)} formatDate={formatDate} />)
            : <EmptyState title="Nada aguardando" detail="Nenhuma candidatura automática está esperando sua confirmação." />}
        </div>
      </section>
    </>
  );
}
