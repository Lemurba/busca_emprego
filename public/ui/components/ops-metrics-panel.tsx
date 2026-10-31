/**
 * F17 — painel "Saúde da instalação" da página "Saúde das buscas": idade do último backup,
 * tamanho do banco, filas que esperam alguém e a última rodada, lidos de `GET /api/metrics`.
 *
 * Autocontido como o painel de conectores: busca os dados ao montar, quando a página recebe
 * dados novos (`revision`, ex. "Sincronizar") e no botão "Atualizar" (que para a propagação,
 * para o handler global de cliques do #view não marcá-lo ocupado; o painel cuida do próprio
 * estado ocupado). Uma falha ao atualizar mantém os últimos números, com o aviso ao lado.
 */
import { useCallback, useEffect, useState } from "preact/hooks";
import { countLabel } from "../plural.js";

export type OperationalMetrics = {
  generated_at: string;
  uptime_seconds: number;
  database: { bytes: number; wal_bytes: number };
  backup: { status: "ok" | "stale" | "missing" | "unavailable"; latest_at: string | null; age_seconds: number | null; count: number; stale_after_hours: number };
  queues: { human_questions_open: number; enrichment_pending: number; authorized_applications: { issued: number; claimed: number } };
  last_round: { id: string; status: string; started_at: string; finished_at: string | null; error_code: string | null } | null;
};

export type OpsMetricsDeps = {
  fetchJson: <T>(url: string, options?: RequestInit) => Promise<T>;
  formatDate: (value: string | null | undefined) => string;
  roundStatus: (status: string) => { label: string; tone: string };
  /** Muda quando a página recebe dados novos do bootstrap; dispara nova leitura das métricas. */
  revision?: unknown;
};

const backupStatus: Record<OperationalMetrics["backup"]["status"], [string, string]> = {
  ok: ["Em dia", "teal"],
  stale: ["Atrasado", "red"],
  missing: ["Nenhum backup", "red"],
  unavailable: ["Sem acesso ao diretório", "orange"]
};

/** "há 3 h", "há 2 dias"… a partir de segundos. */
export function formatAge(seconds: number) {
  if (seconds < 60) return "há menos de 1 min";
  if (seconds < 3600) return `há ${Math.floor(seconds / 60)} min`;
  if (seconds < 86_400) return `há ${Math.floor(seconds / 3600)} h`;
  const days = Math.floor(seconds / 86_400);
  return `há ${days} ${days === 1 ? "dia" : "dias"}`;
}

/** Bytes em B/KB/MB/GB (base 1024, uma casa decimal, vírgula do pt-BR). */
export function formatBytes(bytes: number) {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${unit === 0 ? value : value.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} ${units[unit]}`;
}

function BackupItem({ backup, formatDate }: { backup: OperationalMetrics["backup"]; formatDate: OpsMetricsDeps["formatDate"] }) {
  const [label, tone] = backupStatus[backup.status] ?? [backup.status, "orange"];
  const detail = backup.latest_at && backup.age_seconds !== null
    ? `${formatAge(backup.age_seconds)} (${formatDate(backup.latest_at)}) · ${backup.count} ${backup.count === 1 ? "cópia" : "cópias"} no diretório`
    : backup.status === "unavailable" ? "O servidor não conseguiu ler o diretório de backup." : "Nenhuma cópia encontrada. Rode o backup agendado (scripts/ops/scheduled-backup.mjs).";
  return (
    <article class="ops-item">
      <div><strong>Último backup</strong><span>{`${detail}${backup.status === "stale" ? ` · mais de ${backup.stale_after_hours} h sem cópia nova` : ""}`}</span></div>
      <span class={`status-pill ${tone}`}>{label}</span>
    </article>
  );
}

export function OpsMetricsPanel({ fetchJson, formatDate, roundStatus, revision }: OpsMetricsDeps) {
  const [metrics, setMetrics] = useState<OperationalMetrics | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setMetrics(await fetchJson<OperationalMetrics>("/api/metrics"));
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Não foi possível carregar as métricas.");
    } finally {
      setLoading(false);
    }
  }, [fetchJson]);

  // `revision` não é lido no efeito: só sinaliza que a página recebeu dados novos.
  useEffect(() => { void refresh(); }, [refresh, revision]);

  // Aviso em região viva: anuncia carregamento e falha sem tirar o foco de quem clicou.
  let status = "";
  if (loadError) status = metrics ? `Não foi possível atualizar (${loadError}); mostrando os dados de ${formatDate(metrics.generated_at)}.` : loadError;
  else if (loading) status = metrics ? "Atualizando…" : "Carregando…";
  let body = null;
  if (metrics) {
    const { database, queues, last_round: round } = metrics;
    const status = round ? roundStatus(round.status) : null;
    body = (
      <div class="ops-list">
        <BackupItem backup={metrics.backup} formatDate={formatDate} />
        <article class="ops-item">
          <div><strong>Banco de dados</strong><span>{`${formatBytes(database.bytes)}${database.wal_bytes ? ` + ${formatBytes(database.wal_bytes)} de WAL` : ""}`}</span></div>
        </article>
        <article class="ops-item">
          <div><strong>Filas</strong><span>{`${countLabel(queues.human_questions_open, "pergunta aberta", "perguntas abertas")} · ${countLabel(queues.enrichment_pending, "vaga aguardando", "vagas aguardando")} enriquecimento · ${countLabel(queues.authorized_applications.issued, "autorização de envio emitida e ainda válida", "autorizações de envio emitidas e ainda válidas")}, ${queues.authorized_applications.claimed} em execução`}</span></div>
        </article>
        <article class="ops-item">
          <div><strong>Última rodada</strong><span>{round ? `Iniciada em ${formatDate(round.started_at)}${round.finished_at ? ` · terminada em ${formatDate(round.finished_at)}` : ""}${round.error_code ? ` · erro ${round.error_code}` : ""}` : "Nenhuma rodada registrada."}</span></div>
          {status ? <span class={`status-pill ${status.tone}`}>{status.label}</span> : null}
        </article>
      </div>
    );
  }

  return (
    <section class="panel section-spaced" aria-labelledby="ops-metrics-title">
      <div class="section-head flush">
        <div><h2 id="ops-metrics-title">Saúde da instalação</h2><p>Backup, banco e filas que esperam alguém.</p></div>
        <button type="button" class="secondary-button" data-ops-metrics-refresh disabled={loading} aria-busy={loading ? "true" : undefined} onClick={(event) => { event.stopPropagation(); void refresh(); }}>Atualizar</button>
      </div>
      <p class="muted-text" role="status" aria-live="polite" data-ops-metrics-status>{status}</p>
      {body}
    </section>
  );
}
