// Infraestrutura do banco: prontidão (PRAGMA quick_check), sessões persistidas do dashboard e a
// anonimização legada (só pelo comando explícito de ops).
import { db, tx } from "./handle.js";
import { now } from "./util.js";

export function databaseReadiness() {
  const row = db.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
  return { ok: row?.quick_check === "ok", check: row?.quick_check ?? "unknown" };
}

/** Persistência das sessões do dashboard no SQLite (reiniciar o serviço não desloga ninguém). */
export function dashboardSessionStore(tokenFingerprint: string) {
  return {
    load(now = Date.now()): Array<[string, number]> {
      db.prepare("DELETE FROM dashboard_sessions WHERE expires_at <= ? OR token_fingerprint <> ?").run(now, tokenFingerprint);
      return (db.prepare("SELECT token_hash, expires_at FROM dashboard_sessions").all() as Array<{ token_hash: string; expires_at: number }>).map((row) => [row.token_hash, Number(row.expires_at)]);
    },
    save(tokenHash: string, expiresAt: number) {
      db.prepare("INSERT INTO dashboard_sessions (token_hash, token_fingerprint, expires_at) VALUES (?, ?, ?) ON CONFLICT(token_hash) DO UPDATE SET expires_at = excluded.expires_at, token_fingerprint = excluded.token_fingerprint").run(tokenHash, tokenFingerprint, expiresAt);
    },
    remove(tokenHash: string) {
      db.prepare("DELETE FROM dashboard_sessions WHERE token_hash = ?").run(tokenHash);
    },
  };
}

/**
 * Anonimização legada (TD-13): apaga de forma irreversível os dados das vagas, notas de
 * candidaturas, payloads de auditoria e mensagens de agentes. Nunca roda como efeito colateral
 * de importar este módulo (dashboard, MCP, scripts); só pelo comando explícito
 * `scripts/ops/anonymize-legacy.mjs`, e ainda assim apenas com RADAR_RUN_LEGACY_ANONYMIZATION=true.
 * Roda uma única vez por banco (marca em schema_migrations). Não altera schema; por isso fica
 * fora das migrações.
 */
export function runLegacyAnonymization(): { applied: boolean; jobs: number } {
  if (process.env.RADAR_RUN_LEGACY_ANONYMIZATION !== "true") throw new Error("legacy_anonymization.disabled");
  const migration = "anonymize_public_vacancy_data_v1";
  if (db.prepare("SELECT name FROM schema_migrations WHERE name = ?").get(migration)) return { applied: false, jobs: 0 };

  return tx(() => {
    const jobs = db.prepare("SELECT id FROM jobs ORDER BY created_at, id").all() as { id: string }[];
    const redact = db.prepare(`UPDATE jobs SET
      title = ?, company = 'Empresa confidencial', location = 'Brasil', country = 'Brasil',
      latitude = NULL, longitude = NULL,
      work_model = 'Não informado', seniority = 'Não informado', salary_min = NULL, salary_max = NULL,
      salary_source = 'Não informado', salary_source_url = '', salary_checked_at = NULL,
      salary_confidence = 'not_checked', source = 'Confidencial', source_url = '', linkedin_post_url = '', job_url = '', application_url = '',
      opening_status = 'unknown', opening_checked_at = NULL, deadline_at = NULL, closed_at = NULL,
      decision_at = NULL, description = '', benefits = '', requirements = '', responsibilities = '', additional_information = '', match_score = 0, posted_at = NULL
      WHERE id = ?`);
    jobs.forEach((job, index) => { redact.run(`Vaga anonimizada ${String(index + 1).padStart(3, "0")}`, job.id); });
    db.prepare("UPDATE applications SET notes = '', automation_mode = 'assisted', auto_authorized_at = NULL, authorized_resume_id = NULL, authorized_resume_version = NULL").run();
    db.prepare("UPDATE audit_events SET payload = '{\"redacted\":true}'").run();
    db.prepare("UPDATE agent_runs SET agent_name = 'Agente', message = ''").run();
    db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(migration, now());
    return { applied: true, jobs: jobs.length };
  });
}
