/**
 * Página "Candidaturas" em Preact (antes `renderApplications()` em app.ts).
 *
 * Mesmas classes, textos e atributos `data-*` da versão em string: "Abrir"/"Revisar vaga"
 * (`data-detail`) continuam abrindo o detalhe legado da vaga, e "Ver todas →"
 * (`data-page`) troca de página, ambos pela delegação de eventos do #view.
 */
import type { Data } from "../../app.js";
import { appData } from "../app-state.js";
import { authorizationText } from "../components/automation-panel.js";
import { EmptyState } from "../components/empty-state.js";
import { MetricCard } from "../components/metric-card.js";
import { PageHeading } from "../components/page-heading.js";

type Job = Data["jobs"][number];

/** Vocabulário e formatação que continuam definidos em app.ts. */
export type ApplicationsPageProps = {
  title: string;
  applicationStatusLabel: (status: string) => string;
  applicationStatusTone: (status: string) => string;
  automationModeLabel: (mode: string) => string;
  decisionLabel: (decision: string) => string;
  lifecycle: (job: Job) => { label: string; tone: string };
  formatDate: (value: string | null | undefined) => string;
  relativeApplication: (job: Job) => string;
  deadlineText: (job: Job) => string;
  daysUntil: (value: string | null | undefined) => number | null;
};

const queuedStatuses = ["queued", "in_progress", "awaiting_final_confirmation", "needs_review"];

export function ApplicationsPage(props: ApplicationsPageProps) {
  const { title, formatDate, deadlineText, daysUntil } = props;
  const data = appData();
  const byId = new Map(data.jobs.map((job) => [job.id, job]));
  const applications = data.applications.filter((application) => byId.has(application.job_id));
  const pending = data.jobs
    .filter((job) => job.lifecycle === "open" || job.lifecycle === "unknown")
    .sort((a, b) => (daysUntil(a.deadline_at) ?? 999) - (daysUntil(b.deadline_at) ?? 999));
  return (
    <>
      <PageHeading title={title} subtitle="Veja quando cada candidatura foi registrada e há quanto tempo ela está no histórico." />
      <div class="metric-grid">
        <MetricCard text="Enviadas" value={data.stats.applied ?? 0} note="Com data registrada" icon="✓" tone="teal" highlight />
        <MetricCard text="Na fila" value={applications.filter((item) => queuedStatuses.includes(item.status)).length} note="Precisam de revisão ou envio" icon="↗" tone="orange" />
        <MetricCard text="Vagas perdidas" value={data.stats.lost ?? 0} note="Prazo passou sem envio" icon="!" tone="red" />
        <MetricCard text="Sem interesse" value={data.stats.notInterested ?? 0} note="Decisão registrada" icon="×" tone="neutral" />
      </div>
      <div class="section-head"><div><h2>Histórico de candidaturas</h2><p>Uma data só é registrada quando o envio é confirmado.</p></div></div>
      <div class="table-wrap">
        <table class="data-table responsive-table">
          <thead><tr><th>Vaga</th><th>Estado</th><th>Data da candidatura</th><th>Tempo desde envio</th><th>Modo</th><th>Autorização</th><th>Etapa</th><th><span class="visually-hidden">Ações</span></th></tr></thead>
          <tbody>
            {applications.length ? applications.map((application) => {
              const job = byId.get(application.job_id)!;
              return (
                <tr key={application.id}>
                  <td data-label="Vaga"><button type="button" class="table-link" data-detail={job.id}>{job.title}</button><small>{job.company}</small></td>
                  <td data-label="Estado"><span class={`status-pill ${props.applicationStatusTone(application.status)}`}>{props.applicationStatusLabel(application.status)}</span></td>
                  <td data-label="Data">{formatDate(application.submitted_at)}</td>
                  <td data-label="Desde o envio">{job.application_date ? props.relativeApplication(job) : "Ainda não enviada"}</td>
                  <td data-label="Modo">{props.automationModeLabel(application.automation_mode)}</td>
                  <td data-label="Autorização">{authorizationText(data.automation, application.id, formatDate)}</td>
                  <td data-label="Etapa">{application.current_step || "—"}</td>
                  <td class="cell-action"><button type="button" class="secondary-button" data-detail={job.id} aria-label={`Abrir ${job.title}`}>Abrir</button></td>
                </tr>
              );
            }) : (
              <tr><td colSpan={8}><EmptyState title="Nenhuma candidatura registrada" detail="Abra uma vaga e registre o envio quando ele acontecer." /></td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div class="section-head">
        <div><h2>Vagas ainda sem candidatura</h2><p>Abertas ou a confirmar, ordenadas pelo prazo.</p></div>
        {pending.length > 6 ? <button type="button" class="text-button" data-page="jobs">Ver todas →</button> : null}
      </div>
      <div class="company-grid">
        {pending.length ? pending.slice(0, 6).map((job) => {
          const lifecycle = props.lifecycle(job);
          return (
            <article key={job.id} class="company-card">
              <div class="company-top"><div><h3>{job.title}</h3><p>{`${job.company} · ${job.location}`}</p></div><span class={`status-pill ${lifecycle.tone}`}>{lifecycle.label}</span></div>
              <div class="company-stat"><div><span>Prazo</span><strong>{deadlineText(job)}</strong></div><div><span>Decisão</span><strong>{props.decisionLabel(job.decision)}</strong></div></div>
              <button type="button" class="secondary-button" data-detail={job.id}>Revisar vaga</button>
            </article>
          );
        }) : <EmptyState title="Todas as vagas estão encaminhadas" />}
      </div>
    </>
  );
}
