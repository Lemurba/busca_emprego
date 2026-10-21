import { baseline } from "./0001_baseline.js";
import { migration0002 } from "./0002_resume_fact_checks.js";
import { migration0003 } from "./0003_executor_ats_dry_run.js";
import type { Migration } from "./types.js";

/**
 * Registro ordenado das migrações versionadas. Para criar uma nova, veja README.md nesta pasta.
 *
 * IDs reservados para branches de features em paralelo (não reutilize nem renumere):
 *   0002 → #31 checagem de fatos
 *   0003 → #32 executor
 *   0004 → #33 vaga viva / repost
 *   0005 → #34 score / blockers
 *   0006 → #35 JSON Resume
 * Próximo id livre para outras mudanças: 0007.
 */
export const MIGRATIONS: readonly Migration[] = [
  baseline,
  migration0002,
  migration0003
];

export type { Migration } from "./types.js";
export { ensureColumn } from "./types.js";
