/**
 * Revisão do perfil em rascunho (#49), na página "Saúde das buscas".
 *
 * Lista cada informação proposta (rótulo, valor, origem e evidência: página/trecho do PDF ou o
 * JSON Pointer do JSON Resume) com Confirmar/Rejeitar, e as ações do rascunho: "Confirmar todos
 * os pendentes", "Confirmar perfil" (desabilitado com o motivo enquanto houver pendentes, como
 * PROFILE_FACTS_UNCONFIRMED no servidor) e "Descartar rascunho". Também traz a entrevista dos
 * eliminatórios (`data-form="profile-interview"`).
 *
 * As ações seguem a delegação de eventos do #view: botões com `data-action` vão para
 * `handleAction` e o formulário para `handleForm` (app.ts). Só a escolha de qual rascunho
 * revisar, quando há mais de um, é estado local do componente.
 */
import { useState } from "preact/hooks";
import type { DraftProfile, ProfileFact } from "../../app.js";

export type ProfileDraftPanelProps = {
  drafts: DraftProfile[];
  factTypeLabel: (type: string) => string;
  originLabel: (origin: string) => string;
  profileSourceLabel: (source: string) => string;
  factDisplay: (fact: ProfileFact) => string;
  formatDate: (value: string | null | undefined) => string;
  workModelLabels: Record<string, string>;
};

const PENDING_STATES = ["proposed", "needs_review"];
const stateMeta: Record<string, { label: string; tone: string }> = {
  proposed: { label: "A revisar", tone: "orange" },
  needs_review: { label: "A revisar", tone: "orange" },
  confirmed: { label: "Confirmado", tone: "teal" },
  rejected: { label: "Rejeitado", tone: "neutral" },
};

function plural(count: number, singular: string, pluralForm: string) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function hasEvidence(fact: ProfileFact) {
  return fact.origin === "user" || fact.evidence_page != null || Boolean(String(fact.evidence_excerpt ?? "").trim());
}

/** De onde a informação saiu: JSON Pointer do import, página e trecho do PDF, ou declaração sua. */
function Evidence({ fact }: { fact: ProfileFact }) {
  const excerpt = String(fact.evidence_excerpt ?? "").trim();
  if (fact.origin === "import" && excerpt.startsWith("/")) return <span>Trecho do JSON Resume: <code>{excerpt}</code></span>;
  if (fact.origin === "user") return <span>Declaração sua</span>;
  const parts = [fact.evidence_page != null ? `página ${fact.evidence_page}` : "", excerpt ? `“${excerpt.length > 180 ? `${excerpt.slice(0, 180)}…` : excerpt}”` : ""].filter(Boolean);
  return <span>{parts.length ? `Evidência: ${parts.join(" · ")}` : "Sem evidência: só pode ser rejeitada ou respondida na entrevista abaixo."}</span>;
}

function FactRow({ fact, profileId, props }: { fact: ProfileFact; profileId: string; props: ProfileDraftPanelProps }) {
  const label = props.factTypeLabel(fact.type);
  const meta = stateMeta[fact.state] ?? { label: fact.state, tone: "orange" };
  const confirmable = hasEvidence(fact);
  return (
    <article class="ops-item profile-fact" id={`profile-fact-${fact.id}`} tabIndex={-1} data-fact-state={fact.state}>
      <div>
        <strong>{label}</strong>
        <span class="profile-fact-value">{props.factDisplay(fact) || "—"}</span>
        <span>{`Origem: ${props.originLabel(fact.origin)}`}</span>
        <Evidence fact={fact} />
      </div>
      <div class="button-row">
        <span class={`status-pill ${meta.tone}`}>{meta.label}</span>
        {fact.state !== "confirmed" ? (
          <button type="button" class="secondary-button" data-action="review-profile-fact" data-profile-id={profileId} data-fact-id={fact.id} data-state="confirmed" disabled={!confirmable} aria-label={`Confirmar ${label}`}>Confirmar</button>
        ) : null}
        {fact.state !== "rejected" ? (
          <button type="button" class="secondary-button" data-action="review-profile-fact" data-profile-id={profileId} data-fact-id={fact.id} data-state="rejected" aria-label={`Rejeitar ${label}`}>Rejeitar</button>
        ) : null}
      </div>
    </article>
  );
}

/** Entrevista dos eliminatórios: respostas suas viram informações confirmadas do rascunho. */
function InterviewForm({ draft, props }: { draft: DraftProfile; props: ProfileDraftPanelProps }) {
  const missing = draft.missing_blockers.map(props.factTypeLabel);
  const prefix = `interview-${draft.id}`;
  return (
    <form data-form="profile-interview" data-profile-id={draft.id} class="profile-interview">
      <h3>Eliminatórios</h3>
      <p class="muted-text">
        {missing.length
          ? `Sem resposta: ${missing.join(", ")}. Sem eles, as vagas mostram “não verificado” nesses pontos (nunca bloqueiam). Preencha só o que quiser responder agora.`
          : "Todos os eliminatórios estão respondidos neste rascunho. Preencha de novo para corrigir uma resposta."}
      </p>
      <div class="form-grid">
        <div class="form-field">
          <label for={`${prefix}-locations`}>Locais aceitos</label>
          <input class="input" id={`${prefix}-locations`} name="accepted_locations" placeholder="São Paulo, Remoto Brasil" />
          <small>Separe por vírgula.</small>
        </div>
        <div class="form-field">
          <label for={`${prefix}-years`}>Anos de experiência</label>
          <input class="input" id={`${prefix}-years`} name="years_experience" type="number" min="0" max="70" step="1" inputMode="numeric" />
        </div>
        <fieldset class="permission-fieldset form-field full">
          <legend>Modelos de trabalho aceitos</legend>
          <div class="permission-grid">
            {["remote", "hybrid", "onsite"].map((model) => (
              <label key={model}><input type="checkbox" name="work_models" value={model} /> <span>{props.workModelLabels[model] ?? model}</span></label>
            ))}
          </div>
        </fieldset>
        <div class="form-field">
          <label for={`${prefix}-countries`}>Países onde pode trabalhar</label>
          <input class="input" id={`${prefix}-countries`} name="work_authorization_countries" placeholder="Brasil, Portugal" />
          <small>Separe por vírgula.</small>
        </div>
        <label class="check-row">
          <input type="checkbox" name="needs_sponsorship" />
          <span>Preciso de patrocínio de visto nesses países</span>
        </label>
      </div>
      <div class="button-row">
        <button type="submit" class="secondary-button">Salvar respostas</button>
      </div>
    </form>
  );
}

export function ProfileDraftPanel(props: ProfileDraftPanelProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { drafts } = props;
  if (!drafts.length) return null;
  const draft = drafts.find((item) => item.id === selectedId) ?? drafts[0]!;
  const others = drafts.filter((item) => item.id !== draft.id);
  const pending = draft.facts.filter((fact) => PENDING_STATES.includes(fact.state));
  const pendingWithEvidence = pending.filter(hasEvidence).length;
  const confirmedCount = draft.facts.filter((fact) => fact.state === "confirmed").length;
  const hasContext = Object.keys(draft.context ?? {}).length > 0;
  // Mesmas regras de confirmProfessionalProfile: sem pendentes e com algo confirmado.
  const blockReason = pending.length
    ? `Faltam ${plural(pending.length, "informação", "informações")} para revisar: confirme ou rejeite cada uma antes de confirmar o perfil.`
    : !confirmedCount && !hasContext ? "Confirme pelo menos uma informação antes de confirmar o perfil." : "";
  return (
    <section class="panel section-spaced profile-draft" aria-labelledby="profile-draft-heading">
      <div class="section-head flush">
        <div>
          <h2 id="profile-draft-heading" tabIndex={-1}>{`Perfil em rascunho (v${draft.version})`}</h2>
          <p>{`Criado a partir de ${props.profileSourceLabel(draft.source)} em ${props.formatDate(draft.created_at)}. Só informações confirmadas entram nas buscas, na nota e nos currículos.`}</p>
        </div>
        <span class={`status-pill ${pending.length ? "orange" : "teal"}`}>{pending.length ? `${plural(pending.length, "pendente", "pendentes")}` : "Revisado"}</span>
      </div>
      <div class="button-row profile-draft-actions">
        <button type="button" class="secondary-button" data-action="confirm-pending-facts" data-profile-id={draft.id} disabled={!pendingWithEvidence}>
          {`Confirmar todos os pendentes${pendingWithEvidence ? ` (${pendingWithEvidence})` : ""}`}
        </button>
        <button type="button" class="primary-button" data-action="confirm-profile" data-profile-id={draft.id} data-profile-version={String(draft.version)} disabled={Boolean(blockReason)} aria-describedby={blockReason ? "profile-confirm-reason" : undefined}>Confirmar perfil</button>
        <button type="button" class="danger-button" data-action="discard-profile" data-profile-id={draft.id} data-profile-version={String(draft.version)}>Descartar rascunho</button>
      </div>
      {blockReason ? <p id="profile-confirm-reason" class="muted-text">{blockReason}</p> : null}
      {pending.length > pendingWithEvidence ? (
        <p class="muted-text">{`${plural(pending.length - pendingWithEvidence, "informação não tem", "informações não têm")} evidência e fica fora de “Confirmar todos”: rejeite ou responda na entrevista.`}</p>
      ) : null}
      <div class="ops-list">
        {draft.facts.length
          ? draft.facts.map((fact) => <FactRow key={fact.id} fact={fact} profileId={draft.id} props={props} />)
          : <p class="muted-text">Nenhuma informação extraída. Responda a entrevista abaixo ou descarte o rascunho.</p>}
      </div>
      <InterviewForm key={draft.id} draft={draft} props={props} />
      {others.length ? (
        <div class="profile-draft-others">
          <h3>Outros rascunhos</h3>
          <div class="ops-list">
            {others.map((other) => (
              <article key={other.id} class="ops-item">
                <div><strong>{`Rascunho v${other.version}`}</strong><span>{`${props.profileSourceLabel(other.source)} · ${plural(other.pending, "pendente", "pendentes")} · ${props.formatDate(other.created_at)}`}</span></div>
                <div class="button-row">
                  <button type="button" class="secondary-button" onClick={() => { setSelectedId(other.id); setTimeout(() => document.getElementById("profile-draft-heading")?.focus(), 0); }}>{`Revisar v${other.version}`}</button>
                  <button type="button" class="danger-button" data-action="discard-profile" data-profile-id={other.id} data-profile-version={String(other.version)}>Descartar</button>
                </div>
              </article>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
