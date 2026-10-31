/**
 * Painel "Fila de enriquecimento" (Agentes): vagas que a coleta determinística não conseguiu
 * completar sem IA e que esperam o agente de enriquecimento (ferramentas MCP
 * radar_list_enrichment_queue / radar_resolve_enrichment). Aqui você acompanha a fila e fecha
 * itens à mão: "Resolvido" quando a vaga já foi completada, "Descartar" quando não vale a pena.
 *
 * Autocontido como o painel de empresas por conector: busca /api/connectors/enrichment-queue e
 * trata os próprios cliques (stopPropagation), sem passar pelos handlers globais do #view.
 * "Ver vaga" usa `data-detail` e segue para a delegação global (abre o detalhe da vaga).
 */
import { useCallback, useEffect, useState } from "preact/hooks";

type EnrichmentItem = { id: string; source_id: string; job_url: string; title: string; company: string; reason: string; created_at: string; job_id: string | null };

export type EnrichmentQueueDeps = {
  fetchJson: <T>(url: string, options?: RequestInit) => Promise<T>;
  formatDate: (value: string | null | undefined) => string;
  toast: (message: string, error?: boolean) => void;
  confirm: (title: string, body: string, confirmLabel: string, danger?: boolean) => Promise<boolean>;
};

const reasonLabels: Record<string, string> = {
  "connector.enrichment.no_structured_data": "A página não tem dados estruturados",
  "connector.enrichment.limit": "Limite de enriquecimentos da rodada",
  "connector.enrichment.failed": "Falha ao ler a página",
  "connector.request_limit": "Limite de requisições da rodada",
  "connector.cost_limit": "Custo máximo da rodada",
  "connector.timeout": "Tempo limite da rodada"
};

const errorMessage = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;

export function EnrichmentQueuePanel({ fetchJson, formatDate, toast, confirm }: EnrichmentQueueDeps) {
  const [items, setItems] = useState<EnrichmentItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setItems(await fetchJson<EnrichmentItem[]>("/api/connectors/enrichment-queue"));
      setLoadError(null);
    } catch (error) {
      setLoadError(errorMessage(error, "Não foi possível carregar a fila."));
    }
  }, [fetchJson]);

  useEffect(() => { void refresh(); }, [refresh]);

  const resolve = (item: EnrichmentItem, status: "done" | "dismissed") => {
    void (async () => {
      if (status === "dismissed" && !await confirm("Descartar da fila?", `“${item.title}” sai da fila e o agente não tentará completá-la. A vaga continua no painel.`, "Descartar", true)) return;
      await fetchJson(`/api/connectors/enrichment-queue/${encodeURIComponent(item.id)}`, { method: "POST", body: JSON.stringify({ status }) });
      await refresh();
      toast(status === "done" ? "Item marcado como resolvido." : "Item descartado da fila.");
    })().catch((error) => toast(errorMessage(error, "Falha na operação"), true));
  };

  let body = <p>Carregando…</p>;
  if (loadError) body = <p>{loadError}</p>;
  else if (items) {
    body = items.length ? (
      <div class="ops-list">
        {items.map((item) => (
          <article key={item.id} class="ops-item" data-enrichment-item={item.id}>
            <div>
              <strong>{item.title}</strong>
              <span>{`${item.company} · ${item.source_id} · ${reasonLabels[item.reason] ?? item.reason} · na fila desde ${formatDate(item.created_at)}`}</span>
            </div>
            <div class="button-row">
              {item.job_id ? <button type="button" class="text-button" data-detail={item.job_id}>Ver vaga</button> : <a class="text-button" href={item.job_url} target="_blank" rel="noopener noreferrer">Abrir anúncio ↗</a>}
              <button type="button" class="secondary-button" onClick={(event) => { event.stopPropagation(); resolve(item, "dismissed"); }}>Descartar</button>
              <button type="button" class="secondary-button" onClick={(event) => { event.stopPropagation(); resolve(item, "done"); }}>Resolvido</button>
            </div>
          </article>
        ))}
      </div>
    ) : <p class="muted-text">Nenhuma vaga esperando enriquecimento.</p>;
  }

  return (
    <section class="panel section-spaced" data-enrichment-queue aria-busy={items === null && !loadError ? "true" : undefined}>
      <div class="section-head flush">
        <div>
          <h2>{`Fila de enriquecimento${items?.length ? ` (${items.length})` : ""}`}</h2>
          <p>Vagas que a coleta automática não completou sem IA. O agente de enriquecimento as completa com evidência e fecha cada item.</p>
        </div>
      </div>
      {body}
    </section>
  );
}
