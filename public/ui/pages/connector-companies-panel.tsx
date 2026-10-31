/**
 * Painel "Empresas por conector" (Configurações): lista curada que a coleta determinística
 * (scripts/ops/collect-connectors.mjs) percorre. Antes era public/connectors-panel.ts, que
 * desenhava o corpo com innerHTML depois do render da página; com o Preact diffando a
 * página no lugar, o painel passou a ser um componente com estado próprio.
 *
 * Autocontido: busca /api/connectors e trata os próprios eventos (handlers Preact), sem
 * passar pelos handlers globais do #view — cliques nos botões e o envio param aqui
 * (stopPropagation), porque o handler global de cliques marcaria o botão como ocupado
 * (disabled, o que impediria o envio do formulário) e o de envio chamaria `handleForm`.
 */
import { useCallback, useEffect, useState } from "preact/hooks";

type ConnectorDefinition = { id: string; name: string; slug_hint: string };
type ConnectorCompany = { id: string; connector: string; slug: string; name: string; query: string; enabled: boolean; last_run_at: string | null; last_status: string | null; last_error: string | null; last_count: number | null };
type ConnectorsResponse = { connectors: ConnectorDefinition[]; companies: ConnectorCompany[] };

export type ConnectorPanelDeps = {
  fetchJson: <T>(url: string, options?: RequestInit) => Promise<T>;
  formatDate: (value: string | null | undefined) => string;
  toast: (message: string, error?: boolean) => void;
  confirm: (title: string, body: string, confirmLabel: string, danger?: boolean) => Promise<boolean>;
  /** Avisa que a lista mudou: a tabela de fontes conta as empresas ativas de cada conector (QAF-08). */
  onCompaniesChange?: () => void;
};

const statusLabels: Record<string, [string, string]> = { ok: ["Coletada", "teal"], failed: ["Falhou", "red"], skipped: ["Interrompida", "orange"] };

const stopPropagation = (event: Event) => event.stopPropagation();

const errorMessage = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;

function CompanyRow({ company, connectorName, formatDate, onToggle, onRemove }: { company: ConnectorCompany; connectorName: string; formatDate: ConnectorPanelDeps["formatDate"]; onToggle: () => void; onRemove: () => void }) {
  const [statusText, tone] = company.last_status ? statusLabels[company.last_status] ?? [company.last_status, "orange"] : ["Ainda não coletada", "neutral"];
  const detail = company.last_status === "ok" ? `${company.last_count ?? 0} vagas · ${formatDate(company.last_run_at)}` : company.last_error ? `${company.last_error} · ${formatDate(company.last_run_at)}` : "";
  return (
    <tr>
      <td>
        <strong>{company.name}</strong><br />
        <small>{connectorName} · {company.slug}{company.query ? ` · busca “${company.query}”` : ""}</small>
      </td>
      <td>
        <span class={`status-pill ${tone}`}>{statusText}</span>
        {detail ? <><br /><small>{detail}</small></> : null}
      </td>
      <td><span class={`status-pill ${company.enabled ? "teal" : "neutral"}`}>{company.enabled ? "Ativa" : "Pausada"}</span></td>
      <td>
        <button type="button" class="secondary-button" data-connector-toggle={company.id} data-enabled={company.enabled ? "1" : "0"} onClick={(event) => { event.stopPropagation(); onToggle(); }}>{company.enabled ? "Pausar" : "Ativar"}</button>
        {" "}
        <button type="button" class="text-button danger-text" data-connector-delete={company.id} data-name={company.name} onClick={(event) => { event.stopPropagation(); onRemove(); }}>Remover</button>
      </td>
    </tr>
  );
}

export function ConnectorCompaniesPanel({ fetchJson, formatDate, toast, confirm, onCompaniesChange }: ConnectorPanelDeps) {
  const [data, setData] = useState<ConnectorsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedConnector, setSelectedConnector] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setData(await fetchJson<ConnectorsResponse>("/api/connectors"));
      setLoadError(null);
    } catch (error) {
      setLoadError(errorMessage(error, "Não foi possível carregar as empresas."));
    } finally {
      setLoading(false);
    }
  }, [fetchJson]);

  useEffect(() => { void refresh(); }, [refresh]);

  const run = (operation: () => Promise<unknown>) => {
    void operation().catch((error) => toast(errorMessage(error, "Falha na operação"), true));
  };
  // Depois de mudar a lista: recarrega o painel e avisa a página (contagem por conector nas fontes).
  const changed = async () => {
    await refresh();
    onCompaniesChange?.();
  };
  const toggle = (company: ConnectorCompany) => run(async () => {
    await fetchJson(`/api/connectors/companies/${encodeURIComponent(company.id)}`, { method: "PATCH", body: JSON.stringify({ enabled: !company.enabled }) });
    await changed();
  });
  const remove = (company: ConnectorCompany) => run(async () => {
    if (!await confirm("Remover empresa?", `“${company.name}” sai da coleta automática. As vagas já coletadas continuam no painel.`, "Remover", true)) return;
    await fetchJson(`/api/connectors/companies/${encodeURIComponent(company.id)}`, { method: "DELETE" });
    await changed();
  });
  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const form = event.currentTarget as HTMLFormElement;
    const values = new FormData(form);
    const value = (name: string) => String(values.get(name) ?? "").trim();
    void fetchJson("/api/connectors/companies", { method: "POST", body: JSON.stringify({ connector: value("connector"), slug: value("slug"), name: value("name") || value("slug"), query: value("query") }) })
      .then(async () => {
        // Como no painel antigo (que redesenhava o formulário), volta ao formulário vazio.
        form.reset();
        setSelectedConnector(null);
        await changed();
        toast("Empresa adicionada à coleta automática.");
      })
      .catch((error) => toast(errorMessage(error, "Falha ao salvar"), true));
  };

  const connectors = data?.connectors ?? [];
  const names = new Map(connectors.map((connector) => [connector.id, connector.name]));
  const hint = (connectors.find((connector) => connector.id === selectedConnector) ?? connectors[0])?.slug_hint ?? "";
  let body = <p>Carregando…</p>;
  if (loadError) body = <p>{loadError}</p>;
  else if (data) {
    body = (
      <>
        <table class="source-table">
          <thead><tr><th>Empresa</th><th>Última coleta</th><th>Estado</th><th><span class="visually-hidden">Ações</span></th></tr></thead>
          <tbody>
            {data.companies.length
              ? data.companies.map((company) => (
                <CompanyRow key={company.id} company={company} connectorName={names.get(company.connector) ?? company.connector} formatDate={formatDate} onToggle={() => toggle(company)} onRemove={() => remove(company)} />
              ))
              : <tr><td colSpan={4}>Nenhuma empresa cadastrada.</td></tr>}
          </tbody>
        </table>
        <form data-connector-form class="form-grid section-spaced" onSubmit={submit}>
          <div class="form-field">
            <label for="connector-id">Conector</label>
            <select class="select" id="connector-id" name="connector" onChange={(event) => setSelectedConnector(event.currentTarget.value)}>
              {connectors.map((connector) => <option key={connector.id} value={connector.id} data-hint={connector.slug_hint}>{connector.name}</option>)}
            </select>
          </div>
          <div class="form-field">
            <label for="connector-slug">Identificador no ATS <span class="required" aria-hidden="true">*</span></label>
            <input class="input" id="connector-slug" name="slug" required autocomplete="off" spellcheck={false} aria-describedby="connector-slug-hint" />
            <small id="connector-slug-hint">{hint}</small>
          </div>
          <div class="form-field"><label for="connector-name">Nome da empresa</label><input class="input" id="connector-name" name="name" autocomplete="off" /></div>
          <div class="form-field"><label for="connector-query">Termo de busca (só Gupy)</label><input class="input" id="connector-query" name="query" autocomplete="off" placeholder="Ex.: analista de dados" /></div>
          <div class="form-field full"><button class="primary-button" type="submit" onClick={stopPropagation}><span aria-hidden="true">+</span> Adicionar empresa</button></div>
        </form>
      </>
    );
  }

  return (
    <section class="panel section-spaced" data-connector-panel aria-busy={loading ? "true" : undefined}>
      <div class="section-head flush">
        <div>
          <h2>Empresas por conector</h2>
          <p>A coleta automática lê as vagas públicas destas empresas direto do ATS, sem IA. A fonte do conector precisa estar ativa, com termos aprovados e teste de acesso ok.</p>
        </div>
      </div>
      <div data-connector-body>{body}</div>
    </section>
  );
}
