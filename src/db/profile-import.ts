// Importação/exportação JSON Resume (#35) sobre o banco. Funções recebem a conexão (como em
// agent-configs.ts) para não importar src/db.ts. A exportação é somente leitura.
import { sha256Hex } from "../hash.js";
import type { DatabaseSync } from "node:sqlite";
import { normalizeComparableText } from "../domain.js";
import { experienceToWork, factsToJsonResume, type FactLike, type JsonResume, jsonResumeToFacts, validateJsonResume, type WorkEntry } from "../json-resume.js";
import { isHeading } from "../resume-files.js";
import type { Resume } from "../types.js";
import { now } from "./util.js";

type Row = Record<string, unknown>;

function parseFacts(json: unknown): Row[] {
  try {
    const value = JSON.parse(String(json ?? "[]"));
    return Array.isArray(value) ? value.filter((item): item is Row => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
  } catch {
    return [];
  }
}

/**
 * Ordem do documento de origem: fatos importados guardam o JSON Pointer ("/work/1"), então
 * entradas do mesmo tipo voltam na ordem original (o banco ordena por created_at,id, e o id é
 * um hash). Fatos sem ponteiro mantêm a ordem recebida (sort estável).
 */
function inDocumentOrder<T extends Row>(facts: readonly T[]): T[] {
  const rank = (fact: Row) => Number(/^\/[A-Za-z]+\/(\d+)(?:\/|$)/u.exec(String(fact.evidence_excerpt ?? ""))?.[1] ?? 0);
  return [...facts].sort((left, right) => rank(left) - rank(right));
}

function mapFactRow(row: Row): Row {
  let value: unknown = row.value_json;
  try { value = JSON.parse(String(row.value_json)); } catch { /* valor legado malformado fica como texto */ }
  return { ...row, value };
}

/**
 * Fatos confirmados usados na exportação de um currículo: os do snapshot gravado no currículo
 * (`profile_snapshot_id`) ou, sem ele, os do perfil confirmado atual do projeto.
 */
function resumeExportFacts(db: DatabaseSync, resume: Pick<Resume, "profile_snapshot_id">, projectId: string): { facts: Row[]; profileSnapshotId: string | null; factsSource: "resume_snapshot" | "active_profile" | "none" } {
  if (resume.profile_snapshot_id) {
    const snapshot = db.prepare("SELECT id,facts_json FROM profile_snapshots WHERE id=?").get(resume.profile_snapshot_id) as Row | undefined;
    if (snapshot) return { facts: parseFacts(snapshot.facts_json).filter((fact) => fact.state === "confirmed"), profileSnapshotId: String(snapshot.id), factsSource: "resume_snapshot" };
  }
  const active = db.prepare("SELECT id FROM professional_profiles WHERE project_id=? AND status='confirmed' ORDER BY version DESC LIMIT 1").get(projectId) as Row | undefined;
  if (!active) return { facts: [], profileSnapshotId: null, factsSource: "none" };
  const snapshot = db.prepare("SELECT id,facts_json FROM profile_snapshots WHERE profile_id=? ORDER BY profile_version DESC,created_at DESC LIMIT 1").get(String(active.id)) as Row | undefined;
  if (snapshot) return { facts: parseFacts(snapshot.facts_json).filter((fact) => fact.state === "confirmed"), profileSnapshotId: String(snapshot.id), factsSource: "active_profile" };
  const facts = (db.prepare("SELECT * FROM profile_facts WHERE profile_id=? AND state='confirmed' ORDER BY created_at,id").all(String(active.id)) as Row[]).map(mapFactRow);
  return { facts, profileSnapshotId: null, factsSource: "active_profile" };
}

const BULLET = /^[•\-*–—▪◦·‣]\s*/u;
/** Linha no formato do gerador ATS ("skills: TypeScript"): encerra o bloco da experiência atual. */
const FACT_LINE = /^[a-z_]{3,40}:\s/u;

function contains(haystack: string, needle: string) {
  return needle.length >= 2 && ` ${haystack} `.includes(` ${needle} `);
}

/**
 * Distribui as linhas do conteúdo aprovado entre as experiências (melhor esforço): uma linha
 * curta, sem marcador, que cita a empresa (e, havendo empate, o cargo) abre o bloco daquela
 * experiência; as linhas seguintes viram `highlights` até o próximo título de seção, linha de
 * fato ou outra experiência. Linhas fora de qualquer bloco (exceto títulos) vão para `unmapped`.
 */
export function mapContentToWork(content: string, works: readonly WorkEntry[]): { work: WorkEntry[]; unmapped: string[] } {
  const keys = works.map((work) => ({ company: normalizeComparableText(work.name ?? ""), position: normalizeComparableText(work.position ?? "") }));
  const highlights = works.map((): string[] => []);
  const opened = works.map(() => false);
  const unmapped: string[] = [];
  let current = -1;
  const findWork = (line: string) => {
    const text = normalizeComparableText(line);
    let best = -1;
    let bestScore = 0;
    keys.forEach((key, index) => {
      const score = (contains(text, key.company) ? 2 : 0) + (contains(text, key.position) ? 1 : 0);
      if (score >= 2 && score > bestScore) { best = index; bestScore = score; }
    });
    return best;
  };
  for (const raw of content.split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line) continue;
    const bullet = BULLET.test(line);
    if (!bullet && line.length <= 200) {
      const index = findWork(line);
      if (index >= 0) { current = index; opened[index] = true; continue; }
    }
    if (!bullet && (isHeading(line) || FACT_LINE.test(line))) {
      current = -1;
      if (FACT_LINE.test(line)) unmapped.push(line);
      continue;
    }
    if (current >= 0) highlights[current]!.push(line.replace(BULLET, "").trim());
    else unmapped.push(line);
  }
  return {
    // Experiência citada com linhas próprias no currículo: destaques do conteúdo aprovado.
    // Não citada (ou citada só numa linha, como no gerador ATS): mantém os destaques do fato.
    work: works.map((work, index) => ({ ...work, highlights: opened[index] && highlights[index]!.length ? highlights[index]! : (work.highlights ?? []) })),
    unmapped,
  };
}

function approvedAt(db: DatabaseSync, resumeId: string): string | undefined {
  const row = db.prepare("SELECT payload,created_at FROM audit_events WHERE entity_type='resume' AND entity_id=? AND event_type='approved' ORDER BY id DESC LIMIT 1").get(resumeId) as Row | undefined;
  if (!row) return undefined;
  try {
    const payload = JSON.parse(String(row.payload ?? "{}")) as Row;
    return typeof payload.approved_at === "string" ? payload.approved_at : String(row.created_at);
  } catch {
    return String(row.created_at);
  }
}

function contentSha256(content: string) {
  return sha256Hex(content);
}

/** JSON Resume de um currículo adaptado: fatos confirmados + destaques do conteúdo salvo. */
export function buildResumeJsonResume(db: DatabaseSync, resume: Resume, projectId: string): JsonResume {
  const exported = resumeExportFacts(db, resume, projectId);
  const { profileSnapshotId, factsSource } = exported;
  const facts = inDocumentOrder(exported.facts);
  const experiences = facts.filter((fact) => fact.type === "experience").map((fact) => experienceToWork(fact.value));
  const { work, unmapped } = mapContentToWork(resume.content ?? "", experiences);
  const approved = resume.status === "approved" ? approvedAt(db, resume.id) : undefined;
  return factsToJsonResume(facts as FactLike[], {
    work,
    meta: {
      radar: {
        resume_id: resume.id,
        version: resume.version,
        status: resume.status,
        content_sha256: contentSha256(resume.content ?? ""),
        ...(approved ? { approved_at: approved } : {}),
        exported_at: now(),
        profile_snapshot_id: profileSnapshotId,
        facts_source: factsSource,
        unmapped,
      },
    },
  });
}

/** JSON Resume do perfil-mestre: apenas fatos confirmados (do snapshot, se confirmado). */
export function buildProfileJsonResume(db: DatabaseSync, profile: Row): JsonResume {
  const snapshot = profile.status === "draft" ? undefined : db.prepare("SELECT id,facts_json FROM profile_snapshots WHERE profile_id=? ORDER BY profile_version DESC,created_at DESC LIMIT 1").get(String(profile.id)) as Row | undefined;
  const facts = snapshot
    ? parseFacts(snapshot.facts_json).filter((fact) => fact.state === "confirmed")
    : (db.prepare("SELECT * FROM profile_facts WHERE profile_id=? AND state='confirmed' ORDER BY created_at,id").all(String(profile.id)) as Row[]).map(mapFactRow);
  return factsToJsonResume(inDocumentOrder(facts) as FactLike[], {
    meta: { radar: { profile_id: String(profile.id), profile_version: Number(profile.version), profile_status: String(profile.status), source: String(profile.source ?? "pdf"), profile_snapshot_id: snapshot ? String(snapshot.id) : null, exported_at: now() } },
  });
}

/** Confiança padrão de um fato importado: documento estruturado do próprio usuário, mas ainda sujeito a revisão. */
const IMPORT_FACT_CONFIDENCE = 0.9;

/**
 * Valida o documento e devolve os fatos propostos prontos para `addProfileFact`
 * (`origin: "import"`, `state: "proposed"`, `evidence_excerpt` = JSON Pointer).
 * Erros: `profile.import.invalid:<ponteiro>` e `profile.import.empty`.
 */
export function jsonResumeImportFacts(input: unknown): Row[] {
  const result = validateJsonResume(input);
  if (!result.ok) throw new Error(`profile.import.invalid:${result.issues[0]?.path ?? "/"}`);
  const facts = jsonResumeToFacts(result.data);
  if (!facts.length) throw new Error("profile.import.empty");
  return facts.map((fact) => ({ type: fact.type, value: fact.value, evidence_excerpt: fact.evidence_excerpt, origin: "import", state: "proposed", confidence: IMPORT_FACT_CONFIDENCE }));
}
