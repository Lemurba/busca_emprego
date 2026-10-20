import { ensureColumn, type Migration } from "./types.js";

/**
 * #32 — executor: envio só em ATS de empresa, dry-run com 2ª confirmação humana, limite
 * diário e kill-switch.
 *
 * - `settings`: configurações operacionais lidas a cada verificação pelos dois processos
 *   (dashboard e servidor MCP), sem cache: `automation.enabled`, `automation.daily_limit`,
 *   `automation.per_ats_limit`, `automation.ats_allowlist`.
 * - `application_evidence`: captura de tela (PNG) e resumo dos campos preenchidos que o
 *   executor envia antes do clique final; o usuário revisa no painel.
 * - colunas novas em `application_authorizations` para a confirmação final (pedido,
 *   confirmação humana, hash do token de envio de uso único) e a pausa pelo kill-switch.
 *
 * `applications.status` não tem CHECK no baseline: o novo valor `awaiting_final_confirmation`
 * não exige reconstrução da tabela.
 */
export const migration0003: Migration = {
  id: "0003_executor_ats_dry_run",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT
      );

      CREATE TABLE IF NOT EXISTS application_evidence (
        id TEXT PRIMARY KEY,
        application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
        authorization_id TEXT NOT NULL REFERENCES application_authorizations(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('final_confirmation')),
        mime TEXT NOT NULL CHECK(mime IN ('image/png')),
        sha256 TEXT NOT NULL,
        data BLOB NOT NULL,
        summary_json TEXT NOT NULL DEFAULT '[]',
        observed_url TEXT NOT NULL DEFAULT '',
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_application_evidence_application ON application_evidence(application_id, created_at DESC);
    `);
    ensureColumn(db, "application_authorizations", "final_confirmation_requested_at", "TEXT");
    ensureColumn(db, "application_authorizations", "final_confirmation_at", "TEXT");
    ensureColumn(db, "application_authorizations", "final_confirmation_by", "TEXT");
    ensureColumn(db, "application_authorizations", "final_evidence_id", "TEXT");
    ensureColumn(db, "application_authorizations", "submit_token_hash", "TEXT");
    ensureColumn(db, "application_authorizations", "submit_token_issued_at", "TEXT");
    ensureColumn(db, "application_authorizations", "paused_at", "TEXT");
    // O limite diário conta envios consumidos por dia (America/Sao_Paulo).
    db.exec("CREATE INDEX IF NOT EXISTS idx_authorization_consumed ON application_authorizations(consumed_at)");
  }
};
