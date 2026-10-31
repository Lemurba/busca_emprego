// Perfil profissional (#49): rascunhos, fatos, revisão, entrevista, confirmação com snapshot e
// novas versões. Revisar e confirmar são decisões humanas (atores `service:`/`agent:` recusados).
import { randomUUID } from "node:crypto";
import { compactProfileContext as compactContextJson } from "../pdf-profile.js";
import { audit, db, storeProjectId, tx } from "./handle.js";
import { idFor, now, parseObject } from "./util.js";
import { buildProfileJsonResume, jsonResumeImportFacts } from "./profile-import.js";
import { BLOCKER_FACT_TYPES, normalizeBlockerFact } from "../blockers.js";
import { getBaseResumeExtraction, proposeBaseResumeFacts } from "./base-resumes.js";
import { mapProfile, mapProfileFact } from "./mappers.js";
import { DomainError } from "../errors.js";

/**
 * Contexto do perfil compactado em JSON. src/pdf-profile.ts roda também no worker de extração
 * (sem imports locais), então lança Error puro; aqui o limite vira o código de domínio (#29).
 */
function compactProfileContext(context: Record<string, unknown>): string {
  try {
    return compactContextJson(context);
  } catch (error) {
    if (error instanceof Error && error.message === "PROFILE_CONTEXT_TOO_LARGE") throw new DomainError("PROFILE_CONTEXT_TOO_LARGE");
    throw error;
  }
}

export function listProfiles(projectId = storeProjectId()) {
  return (db.prepare("SELECT * FROM professional_profiles WHERE project_id=? ORDER BY version DESC").all(projectId) as Record<string, unknown>[]).map(mapProfile);
}

export function getProfile(id: string, projectId = storeProjectId()): any {
  const row = db.prepare("SELECT * FROM professional_profiles WHERE id=? AND project_id=?").get(id, projectId) as Record<string, unknown> | undefined;
  return row ? mapProfile(row) : null;
}

export function listProfileFacts(profileId: string): any[] {
  return (db.prepare("SELECT * FROM profile_facts WHERE profile_id=? ORDER BY created_at,id").all(profileId) as Record<string, unknown>[]).map(mapProfileFact);
}


/**
 * Valor de um fato do perfil. Listas aceitam só itens primitivos (texto, número, sim/não):
 * um objeto ou lista aninhada viraria "[object Object]" (I49-11) e é recusado com
 * `profile.fact.invalid`. Objetos no topo (trechos de JSON Resume) seguem como estão.
 */
export function factValue(value: unknown): unknown {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    if (value.some((item) => item !== null && typeof item === "object")) throw new DomainError("profile.fact.invalid");
    return value.filter((item) => item != null).map((item) => String(item).trim()).filter(Boolean);
  }
  return value;
}

/** Trecho legível de um valor para a evidência: texto como está, o resto em JSON (nunca "[object Object]"). */
export function factExcerpt(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value) ?? "";
}

/**
 * Ator automatizado (token de serviço `service:*` ou agente MCP `agent:*`): só propõe fatos do
 * perfil. Declarar em nome do usuário, revisar e confirmar são decisões humanas (QA-04/TD-07).
 */
function isAutomatedActor(actor: string): boolean {
  return /^(?:service|agent):/u.test(actor);
}

export function addProfileFact(profileId: string, input: Record<string, unknown>, actor = "user", projectId = storeProjectId()) {
  const profile = getProfile(profileId, projectId);
  if (profile?.status !== "draft") throw new DomainError("profile.draft_required");
  const type = String(input.type ?? "").trim();
  const value = normalizeBlockerFact(type, factValue(input.value));
  const automated = isAutomatedActor(actor);
  // QA-04: fato vindo do serviço/agente nunca é declaração humana nem nasce confirmado; fica
  // `derived`/`proposed` para a revisão no dashboard (a borda HTTP já recusa o pedido explícito).
  const requestedOrigin = String(input.origin ?? (automated ? "derived" : "user"));
  const origin = automated && requestedOrigin === "user" ? "derived" : requestedOrigin;
  const requestedState = String(input.state ?? (origin === "user" ? "confirmed" : "proposed"));
  const state = automated && requestedState === "confirmed" ? "proposed" : requestedState;
  const evidencePage = input.evidence_page == null && input.page == null ? null : Number(input.evidence_page ?? input.page);
  // Só a declaração humana ganha trecho padrão. Fato do serviço/agente traz a própria evidência
  // ou fica sem ela (e então não pode ser confirmado como está); quem informou fica na auditoria.
  const defaultExcerpt = origin === "user" ? `Declaração humana: ${factExcerpt(value).slice(0, 200)}` : "";
  const evidenceExcerpt = String(input.evidence_excerpt ?? input.excerpt ?? defaultExcerpt).trim().slice(0, 500);
  const confidence = Number(input.confidence ?? (origin === "user" ? 1 : 0.8));
  if (!type || type.length > 80 || value == null || value === "" || (Array.isArray(value) && value.length === 0)) throw new DomainError("profile.fact.invalid");
  if (!["pdf", "user", "derived", "import"].includes(origin) || !["proposed", "confirmed", "rejected", "needs_review"].includes(state)) throw new DomainError("profile.fact.state.invalid");
  if (state === "confirmed" && origin !== "user" && !evidenceExcerpt && evidencePage == null) throw new DomainError("profile.fact.evidence.required");
  // Fato importado (JSON Resume) tem como evidência o JSON Pointer do trecho de origem ("/work/0").
  if (origin === "import" && !evidenceExcerpt.startsWith("/")) throw new DomainError("profile.fact.evidence.required");
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new DomainError("profile.fact.confidence.invalid");
  if (evidencePage != null && (!Number.isInteger(evidencePage) || evidencePage < 1)) throw new DomainError("profile.fact.invalid");
  // Fato "do PDF" vindo do serviço/agente precisa apontar a página de onde saiu.
  if (automated && origin === "pdf" && evidencePage == null) throw new DomainError("profile.fact.evidence.required");
  const id = String(input.id ?? idFor(`profile-fact|${profileId}|${type}|${JSON.stringify(value)}|${Date.now()}|${Math.random()}`));
  const timestamp = now();
  db.prepare(`INSERT INTO profile_facts
    (id,profile_id,type,value_json,evidence_page,evidence_excerpt,origin,confidence,state,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, profileId, type, JSON.stringify(value), evidencePage, evidenceExcerpt, origin, confidence, state, timestamp, timestamp);
  audit("profile_fact", id, "created", { profile_id: profileId, type, origin, state, actor });
  return mapProfileFact(db.prepare("SELECT * FROM profile_facts WHERE id=?").get(id) as Record<string, unknown>);
}

/** Revisa um fato; com `profileId`, o fato precisa pertencer a esse perfil (senão, não encontrado). */
export function reviewProfileFact(id: string, state: string, actor = "user", profileId?: string) {
  if (isAutomatedActor(actor)) throw new DomainError("profile.fact.review.forbidden");
  if (!["proposed", "confirmed", "rejected", "needs_review"].includes(state)) throw new DomainError("profile.fact.state.invalid");
  const row = db.prepare("SELECT f.*,p.status AS profile_status FROM profile_facts f JOIN professional_profiles p ON p.id=f.profile_id WHERE f.id=?").get(id) as Record<string, unknown> | undefined;
  if (!row || (profileId !== undefined && row.profile_id !== profileId)) throw new DomainError("profile.fact.not_found");
  if (row.profile_status !== "draft") throw new DomainError("profile.draft_required");
  if (state === "confirmed" && row.origin !== "user" && row.evidence_page == null && !String(row.evidence_excerpt ?? "").trim()) throw new DomainError("profile.fact.evidence.required");
  db.prepare("UPDATE profile_facts SET state=?,updated_at=? WHERE id=?").run(state, now(), id);
  audit("profile_fact", id, "reviewed", { state, actor });
  return mapProfileFact(db.prepare("SELECT * FROM profile_facts WHERE id=?").get(id) as Record<string, unknown>);
}

/**
 * Próxima versão de perfil: maior versão existente OU já descartada + 1. Um rascunho descartado
 * (QA-10) não devolve o número: "Rascunho v2" nunca volta para outro perfil, e a auditoria não
 * mostra dois `draft_created` v2 diferentes.
 */
function nextProfileVersion(projectId: string): number {
  const live = Number((db.prepare("SELECT COALESCE(MAX(version),0) AS version FROM professional_profiles WHERE project_id=?").get(projectId) as { version: number }).version);
  const deleted = Number((db.prepare(`SELECT COALESCE(MAX(CAST(json_extract(payload,'$.version') AS INTEGER)),0) AS version FROM audit_events
    WHERE entity_type='profile' AND event_type='draft_deleted' AND json_extract(payload,'$.project_id')=?`).get(projectId) as { version: number }).version);
  return Math.max(live, deleted) + 1;
}

/**
 * Um rascunho por vez (#49, QA-10): criar outro (PDF-base, JSON Resume, nova versão) enquanto há um
 * aberto acumulava rascunhos e permitia confirmar um rascunho velho por cima do perfil ativo.
 */
function assertNoOpenDraft(projectId: string) {
  if (db.prepare("SELECT 1 FROM professional_profiles WHERE project_id=? AND status='draft' LIMIT 1").get(projectId)) throw new DomainError("profile.draft_exists");
}

/** `options.source` não vem do corpo da requisição: só o import de JSON Resume cria perfis `json_resume`. */
export function createProfessionalProfile(input: Record<string, unknown>, actor = "user", projectId = storeProjectId(), options: { source?: string } = {}): any {
  const baseResumeId = input.base_resume_id == null || input.base_resume_id === "" ? null : String(input.base_resume_id);
  if (baseResumeId && !db.prepare("SELECT id FROM base_resumes WHERE id=?").get(baseResumeId)) throw new DomainError("base_resume.not_found");
  const source = options.source ?? "pdf";
  if (!["pdf", "json_resume"].includes(source)) throw new DomainError("profile.source.invalid");
  const context = parseObject(input.context ?? input.context_json);
  const contextJson = compactProfileContext(context);
  const facts = Array.isArray(input.facts) ? input.facts : [];
  const timestamp = now();
  // Profile row and facts are one unit: an invalid fact must not leave an empty draft behind.
  const id = tx(() => {
    const version = nextProfileVersion(projectId);
    const profileId = String(input.id ?? idFor(`profile|${projectId}|${version}|${randomUUID()}`));
    db.prepare(`INSERT INTO professional_profiles
      (id,project_id,version,status,base_resume_id,context_json,source,created_at,updated_at)
      VALUES (?,?,?,'draft',?,?,?,?,?)`).run(profileId, projectId, version, baseResumeId, contextJson, source, timestamp, timestamp);
    for (const fact of facts) addProfileFact(profileId, fact as Record<string, unknown>, actor, projectId);
    audit("profile", profileId, "draft_created", { project_id: projectId, version, base_resume_id: baseResumeId, source, fact_count: facts.length, actor });
    return profileId;
  });
  return { ...getProfile(id, projectId), facts: listProfileFacts(id) };
}

/**
 * Rascunho de perfil a partir do PDF-base (I49-13): os fatos propostos usam as páginas reais do
 * PDF, e perfil + fatos entram numa única transação (createProfessionalProfile), então um fato
 * inválido não deixa rascunho vazio para trás.
 */
export async function createProfileFromBaseResume(baseResumeId: string, actor = "user", projectId = storeProjectId()): Promise<any> {
  const base = getBaseResumeExtraction(baseResumeId);
  assertNoOpenDraft(projectId);
  const facts = await proposeBaseResumeFacts(baseResumeId);
  const profile = createProfessionalProfile({ base_resume_id: baseResumeId, facts }, actor, projectId);
  return { ...profile, extraction_status: base.extraction_status };
}

/**
 * Importa um documento JSON Resume como NOVA versão de perfil em rascunho (`source: json_resume`,
 * sem PDF-base). Cada trecho vira um fato `origin: "import"`, `state: "proposed"`, com o JSON
 * Pointer de origem como evidência; o usuário revisa e confirma pelo fluxo normal (snapshot).
 */
export function importJsonResumeProfile(doc: unknown, actor = "user", projectId = storeProjectId()): any {
  const facts = jsonResumeImportFacts(doc);
  assertNoOpenDraft(projectId);
  const profile = createProfessionalProfile({ facts }, actor, projectId, { source: "json_resume" });
  audit("profile", profile.id, "json_resume_imported", { actor, version: profile.version, fact_count: facts.length, types: [...new Set(facts.map((fact) => String(fact.type)))] });
  return profile;
}

/** JSON Resume v1 do perfil-mestre: só fatos confirmados. */
export function exportProfileJsonResume(id: string, projectId = storeProjectId()) {
  const profile = getProfile(id, projectId);
  if (!profile) throw new DomainError("profile.not_found");
  return { profile, document: buildProfileJsonResume(db, profile) };
}

export function updateProfessionalProfile(id: string, input: Record<string, unknown>, actor = "user", projectId = storeProjectId()): any {
  const profile = getProfile(id, projectId);
  if (profile?.status !== "draft") throw new DomainError("profile.draft_required");
  const context = input.context === undefined && input.context_json === undefined ? profile.context : parseObject(input.context ?? input.context_json);
  const contextJson = compactProfileContext(context);
  // Contexto e fatos são uma unidade (como na criação): um fato inválido desfaz o PATCH inteiro.
  tx(() => {
    db.prepare("UPDATE professional_profiles SET context_json=?,updated_at=? WHERE id=? AND project_id=? AND status='draft'").run(contextJson, now(), id, projectId);
    if (Array.isArray(input.facts)) for (const fact of input.facts) addProfileFact(id, fact as Record<string, unknown>, actor, projectId);
    audit("profile", id, "draft_updated", { actor });
  });
  return { ...getProfile(id, projectId), facts: listProfileFacts(id) };
}

function profileContext(profile: ReturnType<typeof getProfile>, facts: ReturnType<typeof listProfileFacts>): string {
  const base = profile?.context ?? {};
  const confirmedFacts = facts.filter((fact) => fact.state === "confirmed").map((fact) => ({ type: fact.type, value: fact.value, confidence: fact.confidence, evidence_page: fact.evidence_page }));
  return compactProfileContext({ ...base, confirmed_facts: confirmedFacts });
}

export function confirmProfessionalProfile(id: string, actor = "user", projectId = storeProjectId()): any {
  if (isAutomatedActor(actor)) throw new DomainError("profile.confirm.forbidden");
  const profile = getProfile(id, projectId);
  if (profile?.status !== "draft") throw new DomainError("profile.draft_required");
  // Rascunho mais velho que o perfil ativo (ex.: a checagem de fatos do currículo confirmou a
  // versão N+1 com o rascunho aberto): confirmá-lo apagaria do perfil ativo o que veio depois.
  const active = db.prepare("SELECT version FROM professional_profiles WHERE project_id=? AND status='confirmed' ORDER BY version DESC LIMIT 1").get(projectId) as { version: number } | undefined;
  if (active && Number(active.version) > Number(profile.version)) throw new DomainError("profile.draft_stale");
  const facts = listProfileFacts(id);
  if (facts.some((fact) => ["proposed", "needs_review"].includes(String(fact.state)))) throw new DomainError("PROFILE_FACTS_UNCONFIRMED");
  if (!facts.some((fact) => fact.state === "confirmed") && !Object.keys(profile.context).length) throw new DomainError("PROFILE_EMPTY");
  const contextJson = profileContext(profile, facts);
  const timestamp = now();
  // tx (e não BEGIN cru) para poder rodar aninhada: a confirmação de fato do currículo (#31) cria a versão N+1 numa só transação.
  tx(() => {
    db.prepare("UPDATE professional_profiles SET status='retired',updated_at=? WHERE project_id=? AND status='confirmed'").run(timestamp, projectId);
    db.prepare("UPDATE professional_profiles SET status='confirmed',context_json=?,confirmed_at=?,confirmed_by=?,updated_at=? WHERE id=? AND project_id=?").run(contextJson, timestamp, actor, timestamp, id, projectId);
    const snapshotId = idFor(`profile-snapshot|${id}|${profile.version}|${contextJson}`);
    db.prepare(`INSERT OR IGNORE INTO profile_snapshots (id,profile_id,profile_version,context_json,facts_json,created_at) VALUES (?,?,?,?,?,?)`)
      .run(snapshotId, id, profile.version, contextJson, JSON.stringify(facts.filter((fact) => fact.state === "confirmed")), timestamp);
    audit("profile", id, "confirmed", { actor, version: profile.version });
  });
  return { ...getProfile(id, projectId), facts: listProfileFacts(id), snapshot: getLatestProfileSnapshot(id) };
}

/** Fatos que ainda pedem decisão humana; enquanto houver algum, o perfil não é confirmado (PROFILE_FACTS_UNCONFIRMED). */
const PENDING_FACT_STATES = ["proposed", "needs_review"];

function isPendingFact(fact: { state?: unknown }): boolean {
  return PENDING_FACT_STATES.includes(String(fact.state));
}

/** Fato que pode ser confirmado como está: declaração humana ou com evidência (página ou trecho). */
function factHasEvidence(fact: { origin?: unknown; evidence_page?: unknown; evidence_excerpt?: unknown }): boolean {
  return fact.origin === "user" || fact.evidence_page != null || Boolean(String(fact.evidence_excerpt ?? "").trim());
}

/**
 * Resposta da entrevista repassada por serviço/agente (id determinístico, ver answerProfileInterview):
 * o "trecho" é o próprio texto do agente, não evidência. Confirma-se só uma a uma (QA-04), nunca
 * por "Confirmar todos os pendentes".
 */
function isInterviewProposal(fact: { id?: unknown; profile_id?: unknown; type?: unknown; origin?: unknown }): boolean {
  return fact.origin === "derived" && fact.id === idFor(`interview-fact|${fact.profile_id}|${fact.type}`);
}

/**
 * Rascunhos de perfil para a revisão no dashboard (#49): cada um com os fatos, a contagem de
 * pendentes (mesma regra que bloqueia `confirmProfessionalProfile`) e os eliminatórios ainda sem
 * fato confirmado (perguntas da entrevista). Mais recente primeiro.
 */
export function listDraftProfiles(projectId = storeProjectId()): any[] {
  return listProfiles(projectId).filter((profile) => profile.status === "draft").map((profile) => {
    const facts = listProfileFacts(profile.id);
    const confirmedTypes = new Set(facts.filter((fact) => fact.state === "confirmed").map((fact) => String(fact.type)));
    return {
      ...profile,
      facts: facts.map((fact) => ({ ...fact, interview_proposal: isInterviewProposal(fact) })),
      pending: facts.filter(isPendingFact).length,
      pending_without_evidence: facts.filter((fact) => isPendingFact(fact) && !factHasEvidence(fact)).length,
      missing_blockers: BLOCKER_FACT_TYPES.filter((type) => !confirmedTypes.has(type)),
    };
  });
}

/**
 * "Confirmar todos os pendentes" (#49): confirma, numa transação, os fatos `proposed`/`needs_review`
 * do rascunho que têm evidência. Os sem evidência e as respostas da entrevista repassadas por
 * agente/serviço ficam pendentes (a pessoa revisa uma a uma) e voltam em `skipped`. Decisão humana: atores automatizados recebem `profile.fact.review.forbidden`.
 */
export function reviewAllProfileFacts(profileId: string, state: string, actor = "user", projectId = storeProjectId()) {
  if (isAutomatedActor(actor)) throw new DomainError("profile.fact.review.forbidden");
  if (state !== "confirmed") throw new DomainError("profile.fact.state.invalid");
  const profile = getProfile(profileId, projectId);
  if (!profile) throw new DomainError("profile.not_found");
  if (profile.status !== "draft") throw new DomainError("profile.draft_required");
  const pending = listProfileFacts(profileId).filter(isPendingFact);
  const ready = pending.filter((fact) => factHasEvidence(fact) && !isInterviewProposal(fact));
  const timestamp = now();
  tx(() => {
    const update = db.prepare("UPDATE profile_facts SET state='confirmed',updated_at=? WHERE id=? AND profile_id=?");
    for (const fact of ready) update.run(timestamp, fact.id, profileId);
    audit("profile", profileId, "facts_reviewed_all", { actor, state, confirmed: ready.length, skipped: pending.length - ready.length });
  });
  return { ...getProfile(profileId, projectId), facts: listProfileFacts(profileId), confirmed: ready.length, skipped: pending.length - ready.length };
}

/**
 * Descarta um rascunho de perfil (#49, QA-10: imports de JSON Resume deixavam rascunhos órfãos).
 * Só rascunho: perfil confirmado ou aposentado tem snapshot e histórico e nunca é apagado.
 * Fatos e entrevistas saem junto (ON DELETE CASCADE).
 */
export function deleteDraftProfile(id: string, actor = "user", projectId = storeProjectId()) {
  if (isAutomatedActor(actor)) throw new DomainError("profile.delete.forbidden");
  const profile = getProfile(id, projectId);
  if (!profile) throw new DomainError("profile.not_found");
  if (profile.status !== "draft") throw new DomainError("profile.draft_required");
  tx(() => {
    db.prepare("DELETE FROM professional_profiles WHERE id=? AND project_id=? AND status='draft'").run(id, projectId);
    audit("profile", id, "draft_deleted", { actor, project_id: projectId, version: profile.version, source: profile.source });
  });
  return { id, deleted: true };
}

/**
 * Cópia de um perfil como novo rascunho (versão N+1): mesmo currículo-base, mesma origem
 * (`pdf`/`json_resume`), contexto sem `confirmed_facts` (recalculado na confirmação) e os fatos
 * copiados com o estado e a evidência que tinham. Roda dentro da transação de quem chama.
 */
export function cloneProfileAsDraft(source: any, actor: string, projectId: string) {
  const context = { ...(source?.context ?? {}) } as Record<string, unknown>;
  delete context.confirmed_facts;
  const draft = createProfessionalProfile({ base_resume_id: source?.base_resume_id ?? null, context }, actor, projectId, { source: source?.source === "json_resume" ? "json_resume" : "pdf" }) as { id: string; version: number };
  const idMap = new Map<string, string>();
  if (source) {
    const copy = db.prepare(`INSERT INTO profile_facts (id,profile_id,type,value_json,evidence_page,evidence_excerpt,origin,confidence,state,created_at,updated_at)
      SELECT ?,?,type,value_json,evidence_page,evidence_excerpt,origin,confidence,state,created_at,? FROM profile_facts WHERE id=?`);
    for (const item of listProfileFacts(source.id)) {
      const newId = idFor(`profile-fact|${draft.id}|${item.id}`);
      copy.run(newId, draft.id, now(), item.id);
      idMap.set(String(item.id), newId);
    }
  }
  return { draft, idMap };
}

/**
 * "Criar nova versão" (#49): o perfil confirmado não aceita fatos nem respostas da entrevista
 * (`profile.draft_required`); para mudar algo, a pessoa abre um rascunho N+1 a partir dele, revisa
 * e confirma de novo. Só um rascunho por vez (`profile.draft_exists`).
 */
export function createProfileNewVersion(id: string, actor = "user", projectId = storeProjectId()): any {
  if (isAutomatedActor(actor)) throw new DomainError("profile.new_version.forbidden");
  const profile = getProfile(id, projectId);
  if (!profile) throw new DomainError("profile.not_found");
  if (profile.status !== "confirmed") throw new DomainError("profile.confirmed_required");
  assertNoOpenDraft(projectId);
  const draftId = tx(() => {
    const { draft } = cloneProfileAsDraft(profile, actor, projectId);
    audit("profile", draft.id, "new_version_created", { actor, from_profile_id: id, from_version: profile.version, version: draft.version });
    return draft.id;
  });
  return { ...getProfile(draftId, projectId), facts: listProfileFacts(draftId) };
}

export function getActiveProfile(projectId = storeProjectId()): any {
  const row = db.prepare("SELECT * FROM professional_profiles WHERE project_id=? AND status='confirmed' ORDER BY version DESC LIMIT 1").get(projectId) as Record<string, unknown> | undefined;
  if (!row) return null;
  const profile = mapProfile(row);
  return { ...profile, facts: listProfileFacts(profile.id), snapshot: getLatestProfileSnapshot(profile.id) };
}

export function getLatestProfileSnapshot(profileId?: string, projectId = storeProjectId()): any {
  const row = profileId
    ? db.prepare("SELECT * FROM profile_snapshots WHERE profile_id=? ORDER BY profile_version DESC,created_at DESC LIMIT 1").get(profileId)
    : db.prepare(`SELECT s.* FROM profile_snapshots s JOIN professional_profiles p ON p.id=s.profile_id WHERE p.project_id=? AND p.status='confirmed' ORDER BY s.profile_version DESC LIMIT 1`).get(projectId);
  if (!row) return null;
  const result = row as Record<string, unknown>;
  return { ...result, facts: JSON.parse(String(result.facts_json ?? "[]")), context: JSON.parse(String(result.context_json ?? "{}")) };
}

export function answerProfileInterview(profileId: string, questionKey: string, answer: unknown, actor = "user", projectId = storeProjectId()) {
  const profile = getProfile(profileId, projectId);
  if (profile?.status !== "draft") throw new DomainError("profile.draft_required");
  const key = questionKey.trim();
  // I49-11: lista com item não primitivo é inválida (antes virava "[object Object]").
  let value: unknown;
  try { value = factValue(answer); } catch { throw new DomainError("profile.interview.invalid"); }
  const normalizedAnswer = normalizeBlockerFact(key, value);
  if (!key || key.length > 80 || normalizedAnswer == null || normalizedAnswer === "" || (Array.isArray(normalizedAnswer) && !normalizedAnswer.length)) throw new DomainError("profile.interview.invalid");
  const timestamp = now();
  const excerptText = factExcerpt(normalizedAnswer).slice(0, 200);
  let alreadyAnswered = false;
  tx(() => {
    if (isAutomatedActor(actor)) {
      // A pessoa já respondeu esta pergunta no dashboard: a resposta do agente não vira proposta
      // (senão "Confirmar" a deixaria valendo por cima da declaração humana).
      const interview = db.prepare("SELECT status FROM profile_interviews WHERE profile_id=? AND question_key=?").get(profileId, key) as { status: string } | undefined;
      if (interview?.status === "answered") { alreadyAnswered = true; return; }
      // QA-04: resposta repassada pelo serviço (Hermes) não é declaração humana verificada:
      // vira fato proposto, com o trecho como evidência, para o usuário confirmar no dashboard.
      // Uma pergunta = um fato proposto (id determinístico): repetir a resposta não empilha
      // fatos para revisar, e resposta nova só reabre a revisão quando o valor muda.
      // A entrevista fica `pending` e nunca sobrescreve uma resposta já dada pela pessoa.
      db.prepare(`INSERT INTO profile_interviews (id,profile_id,question_key,question,answer_json,status,asked_at,answered_at)
        VALUES (?,?,?,?,?,'pending',?,NULL)
        ON CONFLICT(profile_id,question_key) DO UPDATE SET answer_json=excluded.answer_json WHERE profile_interviews.status<>'answered'`)
        .run(idFor(`interview|${profileId}|${key}`), profileId, key, key, JSON.stringify(answer), timestamp);
      const factId = idFor(`interview-fact|${profileId}|${key}`);
      const existing = db.prepare("SELECT value_json FROM profile_facts WHERE id=?").get(factId) as { value_json: string } | undefined;
      const excerpt = `Entrevista via ${actor}: ${excerptText}`;
      if (!existing) addProfileFact(profileId, { id: factId, type: key, value: normalizedAnswer, origin: "derived", state: "proposed", evidence_excerpt: excerpt }, actor, projectId);
      else if (existing.value_json !== JSON.stringify(normalizedAnswer)) {
        db.prepare("UPDATE profile_facts SET value_json=?,evidence_excerpt=?,state='proposed',updated_at=? WHERE id=?").run(JSON.stringify(normalizedAnswer), excerpt, timestamp, factId);
        audit("profile_fact", factId, "reproposed", { profile_id: profileId, type: key, actor });
      }
    } else {
      db.prepare(`INSERT INTO profile_interviews (id,profile_id,question_key,question,answer_json,status,asked_at,answered_at)
        VALUES (?,?,?,?,?,'answered',?,?)
        ON CONFLICT(profile_id,question_key) DO UPDATE SET answer_json=excluded.answer_json,status='answered',answered_at=excluded.answered_at`)
        .run(idFor(`interview|${profileId}|${key}`), profileId, key, key, JSON.stringify(answer), timestamp, timestamp);
      const fact = db.prepare("SELECT id FROM profile_facts WHERE profile_id=? AND type=? AND origin='user' ORDER BY created_at LIMIT 1").get(profileId, key) as { id: string } | undefined;
      if (fact) db.prepare("UPDATE profile_facts SET value_json=?,confidence=1,state='confirmed',evidence_excerpt=?,updated_at=? WHERE id=?").run(JSON.stringify(normalizedAnswer), `Declaração humana: ${excerptText}`, timestamp, fact.id);
      else addProfileFact(profileId, { type: key, value: normalizedAnswer, origin: "user", state: "confirmed" }, actor, projectId);
      // Eliminatório tem um valor só: a resposta humana substitui propostas (PDF, agente, serviço)
      // do mesmo tipo, que são rejeitadas. Sem isso a proposta seguia pendente (bloqueando
      // "Confirmar perfil") ou, confirmada, valia por cima da resposta (blockerProfileFrom).
      if ((BLOCKER_FACT_TYPES as readonly string[]).includes(key)) {
        const superseded = db.prepare("SELECT id FROM profile_facts WHERE profile_id=? AND type=? AND origin<>'user' AND state<>'rejected'").all(profileId, key) as Array<{ id: string }>;
        for (const item of superseded) {
          db.prepare("UPDATE profile_facts SET state='rejected',updated_at=? WHERE id=?").run(timestamp, item.id);
          audit("profile_fact", item.id, "superseded", { profile_id: profileId, type: key, actor });
        }
      }
    }
    audit("profile_interview", profileId, "answered", { question_key: key, actor });
  });
  if (alreadyAnswered) audit("profile_interview", profileId, "ignored_already_answered", { question_key: key, actor });
  return { profile: getProfile(profileId, projectId), facts: listProfileFacts(profileId), already_answered: alreadyAnswered };
}
