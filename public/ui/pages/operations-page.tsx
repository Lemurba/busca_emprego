/**
 * Página "Saúde das buscas" em Preact (antes `renderOperations()` em app.ts).
 *
 * Mesmas classes, textos e atributos `data-*` da versão em string: duplicatas
 * (`data-resolve-duplicate`, `data-undo-duplicate`) e "Responder aqui" (`data-answer-question`),
 * tratados em public/ops-actions.ts, regras (`data-preference-rule`), "Reexibir" (`data-action`),
 * troca de página (`data-page`) e o painel de automação (#32) continuam tratados pela
 * delegação de eventos do #view (`handleViewClick`/`handleAction`/`handleAutomationAction`).
 * #49: revisão do perfil em rascunho (`ProfileDraftPanel`) e CTAs de onboarding do perfil.
 */
import type { BaseResume, Data, ProfileFact } from "../../app.js";
import { appData } from "../app-state.js";
import { AutomationPanel } from "../components/automation-panel.js";
import { EmptyState } from "../components/empty-state.js";
import { MetricCard } from "../components/metric-card.js";
import { OpsMetricsPanel } from "../components/ops-metrics-panel.js";
import { PageHeading } from "../components/page-heading.js";
import { ProfileDraftPanel } from "./profile-draft-panel.js";

type Rule = NonNullable<Data["suppressedJobs"]>[number]["rules"][number];
type Fact = Pick<ProfileFact, "type" | "value" | "origin" | "state"> & { evidence_page?: unknown };
type Tone = { label: string; tone: string };

/** Vocabulário e formatação que continuam definidos em app.ts. */
export type OperationsPageProps = {
  title: string;
  formatDate: (value: string | null | undefined) => string;
  roundStatus: (status: string) => Tone;
  readiness: (status: string | null | undefined) => Tone;
  /** Motivo da prontidão calculada em texto para a pessoa. */
  readinessReason: (reason: string | null | undefined) => string;
  /** Nome da fonte pelo id (as rodadas guardam só os ids). */
  sourceName: (id: string) => string;
  questionStatusLabel: (status: string) => string;
  profileStatusLabel: (status: string) => string;
  profileSourceLabel: (source: string) => string;
  factTypeLabel: (type: string) => string;
  originLabel: (origin: string) => string;
  factDisplay: (fact: Fact) => string;
  describeRule: (rule: any) => string;
  /** Eliminatórios ainda sem fato confirmado no perfil (rótulos já traduzidos). */
  missingBlockers: (facts: Fact[]) => string[];
  /** Cliente da API do app.ts, usado pelo painel de métricas (F17). */
  fetchJson: <T>(url: string, options?: RequestInit) => Promise<T>;
  workModelLabels: Record<string, string>;
};

const openQuestionStatuses = ["pending", "delivered", "delivery_failed"];
const duplicateDecisionLabels: Record<string, string> = { merged: "Mesclada", distinct: "Marcada como diferente", dismissed: "Dispensada" };

function plural(count: number, singular: string, pluralForm: string) {
  return count === 1 ? singular : pluralForm;
}

/** Sem perfil confirmado: caminhos para criar um (PDF-base, JSON Resume) ou seguir no rascunho. */
function ProfileOnboarding({ draft, baseResume, resumes }: { draft: { version: number } | undefined; baseResume: BaseResume | undefined; resumes: BaseResume[] }) {
  const isExtracted = (resume: BaseResume | undefined) => resume?.extraction_status === "extracted";
  // PDF-base sem texto (digitalizado): oferece outro PDF da biblioteca que tenha texto, se houver.
  const source = isExtracted(baseResume) ? baseResume : resumes.find(isExtracted);
  const unreadable = Boolean(baseResume) && !source;
  const text = draft
    ? `O rascunho v${draft.version} espera sua revisão. Confirme o perfil para liberar as buscas, a nota e os currículos.`
    : unreadable
      ? "Não foi possível ler o texto do PDF-base (digitalizado como imagem?): envie um PDF com texto selecionável ou importe um JSON Resume, revise as informações e confirme."
      : "Crie o perfil a partir do currículo-base em PDF ou de um JSON Resume, revise as informações e confirme.";
  return (
    <div class="empty-state">
      <div>
        <strong>Nenhum perfil confirmado</strong>
        <span>{text}</span>
        <div class="button-row">
          {draft ? <button type="button" class="primary-button" data-action="goto-profile-draft">{`Revisar rascunho v${draft.version}`}</button> : null}
          {!draft && source ? <button type="button" class="primary-button" data-action="create-profile-from-base" data-resume-id={source.id}>{source === baseResume ? "Criar perfil a partir do PDF-base" : `Criar perfil a partir de “${source.title}”`}</button> : null}
          {!draft && unreadable ? <button type="button" class="primary-button" data-page="resumes">Enviar outro PDF</button> : null}
          {!draft && !baseResume ? <button type="button" class="primary-button" data-page="resumes">Enviar currículo em PDF</button> : null}
          {!draft ? <button type="button" class="secondary-button" data-page="resumes">Importar JSON Resume</button> : null}
        </div>
      </div>
    </div>
  );
}

function ProfilePanel({ profile, facts, draft, baseResume, resumes, props }: { profile: any; facts: Fact[]; draft: { version: number } | undefined; baseResume: BaseResume | undefined; resumes: BaseResume[]; props: OperationsPageProps }) {
  const missing = profile ? props.missingBlockers(facts) : [];
  return (
    <section class="panel">
      <div class="section-head flush">
        <div><h2 id="active-profile-heading" tabIndex={-1}>Perfil profissional</h2><p>Só informações confirmadas entram nas buscas.</p></div>
        {profile ? (
          <div class="button-row">
            <a class="secondary-button" href={`api/profiles/${encodeURIComponent(profile.id)}/export/json-resume`}>Exportar JSON Resume</a>
            {draft
              ? <button type="button" class="secondary-button" data-action="goto-profile-draft">{`Ir para o rascunho v${draft.version}`}</button>
              : <button type="button" class="secondary-button" data-action="new-profile-version" data-profile-id={profile.id}>Criar nova versão</button>}
            <span class="status-pill teal">{`Perfil ativo v${profile.version}`}</span>
          </div>
        ) : <span class="status-pill red">Ausente</span>}
      </div>
      {profile ? (
        <div class="ops-list">
          {facts.length ? facts.map((fact, index) => (
            <article key={index} class="ops-item">
              <div><strong>{props.factTypeLabel(fact.type)}</strong><span>{`${props.factDisplay(fact)} · ${props.originLabel(fact.origin)}${fact.evidence_page ? ` · página ${fact.evidence_page}` : ""}`}</span></div>
              <span class={`status-pill ${fact.state === "confirmed" ? "teal" : fact.state === "rejected" ? "neutral" : "orange"}`}>{fact.state === "confirmed" ? "Confirmado" : fact.state === "rejected" ? "Rejeitado" : "A revisar"}</span>
            </article>
          )) : <EmptyState title="Perfil sem informações" detail="Crie uma nova versão para revisar as informações." compact />}
        </div>
      ) : <ProfileOnboarding draft={draft} baseResume={baseResume} resumes={resumes} />}
      {missing.length ? <p class="muted-text">{`Eliminatórios sem resposta no perfil: ${missing.join(", ")}. ${draft ? "Responda na entrevista do rascunho abaixo" : "Para responder, crie uma nova versão do perfil e use a entrevista do rascunho"}; respostas dadas ao Hermes chegam ao rascunho como propostas e só valem depois que você as confirma. Até lá essas checagens aparecem como “não verificado”.`}</p> : null}
    </section>
  );
}

export function OperationsPage(props: OperationsPageProps) {
  const { title, formatDate } = props;
  const data = appData();
  const profile = data.activeProfile;
  const facts: Fact[] = profile?.facts ?? [];
  const drafts = data.draftProfiles ?? [];
  const draft = drafts[0];
  const baseResume = data.baseResumes.find((resume) => resume.is_base) ?? data.baseResumes[0];
  const jobName = (id: string) => {
    const job = data.jobs.find((item) => item.id === id);
    return job ? `${job.title} · ${job.company}` : "Vaga removida";
  };
  const applicationJob = new Map(data.applications.map((application) => [application.id, application.job_id]));
  // Regras desfeitas junto com o feedback de origem não podem ser reativadas; ficam fora da lista.
  const rules = data.preferences.rules.filter((rule) => rule.state !== "undone");
  const suppressedJobs = data.suppressedJobs ?? [];
  const openQuestions = data.humanQuestions.filter((question) => openQuestionStatuses.includes(question.status));
  const recentDuplicates = data.recentDuplicateDecisions ?? [];
  return (
    <>
      <PageHeading
        title={title}
        subtitle="Perfil confirmado, rodadas de busca e decisões que dependem de você."
        actions={<button type="button" class="secondary-button" data-page="agents">Ver agentes</button>}
      />
      <div class="metric-grid">
        <MetricCard text="Perfil ativo" value={profile ? `v${profile.version}` : "—"} note={profile ? `${facts.filter((fact) => fact.state === "confirmed").length} informações confirmadas` : draft ? `Rascunho v${draft.version} aguardando revisão` : "Confirmação necessária"} icon="◎" tone="teal" />
        <MetricCard text="Rodadas" value={data.rounds.length} note={`${data.rounds.filter((round) => round.status === "running").length} em execução`} icon="↻" tone="purple" />
        <MetricCard text="Duplicatas" value={data.possibleDuplicates.length} note="aguardando sua decisão" icon="≋" tone="orange" />
        <MetricCard text="Perguntas" value={openQuestions.length} note="esperando sua resposta" icon="?" tone="red" />
      </div>
      <OpsMetricsPanel fetchJson={props.fetchJson} formatDate={formatDate} roundStatus={props.roundStatus} revision={data} />
      <AutomationPanel automation={data.automation} jobLabel={(applicationId, jobId) => jobName(jobId || applicationJob.get(applicationId) || "")} formatDate={formatDate} />
      <div class="dashboard-grid equal section-spaced">
        <ProfilePanel profile={profile} facts={facts} draft={draft} baseResume={baseResume} resumes={data.baseResumes} props={props} />
        <section class="panel">
          <div class="section-head flush"><div><h2>Perguntas para você</h2><p>Os agentes param e esperam sua resposta, no Telegram ou aqui.</p></div></div>
          <div class="ops-list">
            {openQuestions.length ? openQuestions.map((question) => {
              const jobId = applicationJob.get(question.application_id);
              const failed = question.status === "delivery_failed";
              return (
                <article key={question.id} class="ops-item">
                  <div><strong>{question.question}</strong><span>{`${jobId ? jobName(jobId) : "Candidatura removida"} · ${props.questionStatusLabel(question.status)}`}</span></div>
                  <div class="button-row">
                    {failed ? <span class="status-pill red">Não chegou ao Telegram</span> : null}
                    <button type="button" class={failed ? "primary-button" : "secondary-button"} data-answer-question={question.id} aria-label={`Responder aqui: ${question.question}`}>Responder aqui</button>
                  </div>
                </article>
              );
            }) : <EmptyState title="Nenhuma pergunta pendente" detail="Nenhuma automação está esperando por você." />}
          </div>
        </section>
      </div>
      <ProfileDraftPanel drafts={drafts} factTypeLabel={props.factTypeLabel} originLabel={props.originLabel} profileSourceLabel={props.profileSourceLabel} factDisplay={props.factDisplay} formatDate={formatDate} workModelLabels={props.workModelLabels} activeVersion={profile?.version ?? null} />
      <div class="dashboard-grid equal section-spaced">
        <section class="panel">
          <div class="section-head flush"><div><h2>Possíveis duplicatas</h2><p>Quando há dúvida, você decide.</p></div></div>
          <div class="ops-list">
            {data.possibleDuplicates.length ? data.possibleDuplicates.map((duplicate) => (
              <article key={duplicate.id} class="ops-item">
                <div><strong>{jobName(duplicate.job_id)}</strong><span>{`Parece a mesma vaga que ${jobName(duplicate.candidate_job_id)} · ${Math.round(Number(duplicate.similarity) * 100)}% de semelhança`}</span></div>
                <div class="button-row">
                  <button type="button" class="secondary-button" data-resolve-duplicate={duplicate.id} data-resolution="distinct">São diferentes</button>
                  <button type="button" class="primary-button" data-resolve-duplicate={duplicate.id} data-resolution="merged">Mesclar</button>
                </div>
              </article>
            )) : <EmptyState title="Fila limpa" detail="Nenhuma possível duplicata pendente." />}
          </div>
          {recentDuplicates.length ? (
            <>
              <h3 class="subsection-title">Decididas recentemente</h3>
              <p class="muted-text">Mesclar não apaga vagas. Cada decisão pode ser desfeita por 24 horas.</p>
              <div class="ops-list">
                {recentDuplicates.map((duplicate) => (
                  <article key={duplicate.id} class="ops-item">
                    <div><strong>{jobName(duplicate.job_id)}</strong><span>{`${duplicateDecisionLabels[duplicate.status] ?? duplicate.status} com ${jobName(duplicate.candidate_job_id)} · desfazer até ${formatDate(duplicate.undo_until)}`}</span></div>
                    <button type="button" class="secondary-button" data-undo-duplicate={duplicate.id} aria-label={`Desfazer a decisão sobre ${jobName(duplicate.job_id)}`}>Desfazer</button>
                  </article>
                ))}
              </div>
            </>
          ) : null}
        </section>
        <section class="panel">
          <div class="section-head flush"><div><h2>Preferências aprendidas</h2><p>Criadas pelo seu “Não tenho interesse”. Pausar não apaga o histórico.</p></div></div>
          <div class="ops-list">
            {rules.length ? rules.map((rule) => {
              const hidden = Number(rule.hidden_count ?? 0);
              const active = rule.state === "active";
              return (
                <article key={rule.id} class="ops-item">
                  <div><strong>{props.describeRule(rule)}</strong><span>{`${rule.reason || "Sem justificativa"} · ${rule.hidden_count ?? 0} ${plural(hidden, "vaga", "vagas")} ${plural(hidden, "oculta", "ocultas")} agora${active ? "" : " · pausada"}`}</span></div>
                  <button type="button" class="secondary-button" data-preference-rule={rule.id} data-next-state={active ? "paused" : "active"}>{active ? "Pausar" : "Reativar"}</button>
                </article>
              );
            }) : <EmptyState title="Sem regras" detail="Seus motivos de descarte viram regras aqui." />}
          </div>
        </section>
      </div>
      {/* Vagas ocultadas pelas regras: motivo (regra) e ação de reexibir no painel. */}
      <section class="panel section-spaced">
        <div class="section-head flush"><div><h2>{`Ocultadas (${suppressedJobs.length})`}</h2><p>Vagas novas que batem com uma regra “Não tenho interesse” ficam fora do painel. Reexiba se a regra errou.</p></div></div>
        <div class="ops-list">
          {suppressedJobs.length ? suppressedJobs.map((job) => (
            <article key={job.id} class="ops-item">
              <div><strong>{job.title}</strong><span>{`${job.company} · ${job.rules.map((rule: Rule) => `${props.describeRule(rule)}${rule.reason ? ` (${rule.reason})` : ""}`).join("; ") || "Regra removida"}`}</span></div>
              <button type="button" class="secondary-button" data-action="unsuppress-job" data-job-id={job.id}>Reexibir</button>
            </article>
          )) : <EmptyState title="Nenhuma vaga oculta" compact />}
        </div>
      </section>
      <section class="panel section-spaced">
        <div class="section-head flush"><div><h2>Prontidão das fontes</h2><p>As buscas usam só fontes com termos aceitos e teste de acesso aprovado.</p></div><button type="button" class="text-button" data-page="settings">Editar fontes →</button></div>
        <div class="table-wrap flat">
          <table class="data-table responsive-table">
            <thead><tr><th>Fonte</th><th>Prontidão</th><th>Detalhe</th><th>Último teste</th></tr></thead>
            <tbody>
              {data.sourceConfigs.length ? data.sourceConfigs.map((source) => {
                // I49-07: a prontidão calculada (a da rodada), não só o último teste gravado.
                const effective = source.effectiveReadiness ?? { status: source.readiness_status ?? "configured", reason: source.readiness_reason ?? "" };
                const readiness = props.readiness(effective.status);
                return (
                  <tr key={source.id}>
                    <td data-label="Fonte"><strong>{source.name}</strong><small>{source.domain}</small></td>
                    <td data-label="Prontidão"><span class={`status-pill ${readiness.tone}`}>{readiness.label}</span></td>
                    <td data-label="Detalhe">{effective.status === "ready" ? (source.readiness_reason || "Teste de acesso aprovado") : props.readinessReason(effective.reason)}</td>
                    <td data-label="Último teste">{formatDate(source.last_smoke_test_at)}</td>
                  </tr>
                );
              }) : <tr><td colSpan={4}>Nenhuma fonte configurada.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      <section class="panel section-spaced">
        <div class="section-head flush">
          <div><h2>Rodadas de busca</h2><p>Cada rodada guarda o perfil usado e o resultado. A coleta é feita pelos agentes do Hermes.</p></div>
          <button type="button" class="primary-button" data-action="start-round">Iniciar rodada</button>
        </div>
        <div class="table-wrap flat">
          <table class="data-table responsive-table">
            <thead><tr><th>Início</th><th>Estado</th><th>Fontes</th><th>Resultado</th></tr></thead>
            <tbody>
              {data.rounds.length ? data.rounds.map((round, index) => {
                const counters = round.counters ?? {};
                const status = props.roundStatus(round.status);
                return (
                  <tr key={round.id ?? index}>
                    <td data-label="Início"><strong>{formatDate(round.started_at)}</strong></td>
                    <td data-label="Estado"><span class={`status-pill ${status.tone}`}>{status.label}</span></td>
                    <td data-label="Fontes">{(round.source_ids ?? []).map(props.sourceName).join(", ") || "—"}</td>
                    <td data-label="Resultado">{`${counters.received ?? 0} recebidas · ${counters.accepted ?? 0} aceitas`}</td>
                  </tr>
                );
              }) : <tr><td colSpan={4}>Nenhuma rodada registrada.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
