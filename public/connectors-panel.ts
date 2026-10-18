// Painel "Empresas por conector" (Configurações): lista curada que a coleta determinística
// (scripts/ops/collect-connectors.mjs) percorre. Autocontido: busca /api/connectors, desenha a
// tabela e o formulário e trata os próprios eventos, sem passar pelos handlers globais do app.

type ConnectorDefinition = { id: string; name: string; slug_hint: string };
type ConnectorCompany = { id: string; connector: string; slug: string; name: string; query: string; enabled: boolean; last_run_at: string | null; last_status: string | null; last_error: string | null; last_count: number | null };

export interface ConnectorPanelDeps {
  fetchJson: <T>(url: string, options?: RequestInit) => Promise<T>;
  escapeHtml: (value: unknown) => string;
  formatDate: (value: string | null | undefined) => string;
  toast: (message: string, error?: boolean) => void;
  confirm: (title: string, body: string, confirmLabel: string, danger?: boolean) => Promise<boolean>;
}

const statusLabels: Record<string, [string, string]> = { ok: ["Coletada", "teal"], failed: ["Falhou", "red"], skipped: ["Interrompida", "orange"] };

export function connectorCompaniesSection(): string {
  return `<section class="panel section-spaced" data-connector-panel aria-busy="true"><div class="section-head flush"><div><h2>Empresas por conector</h2><p>A coleta automática lê as vagas públicas destas empresas direto do ATS, sem IA. A fonte do conector precisa estar ativa, com termos aprovados e teste de acesso ok.</p></div></div><div data-connector-body><p>Carregando…</p></div></section>`;
}

function renderBody(deps: ConnectorPanelDeps, connectors: ConnectorDefinition[], companies: ConnectorCompany[]) {
  const { escapeHtml, formatDate } = deps;
  const names = new Map(connectors.map((connector) => [connector.id, connector.name]));
  const rows = companies.map((company) => {
    const [statusText, tone] = company.last_status ? statusLabels[company.last_status] ?? [company.last_status, "orange"] : ["Ainda não coletada", "neutral"];
    const detail = company.last_status === "ok" ? `${company.last_count ?? 0} vagas · ${formatDate(company.last_run_at)}` : company.last_error ? `${company.last_error} · ${formatDate(company.last_run_at)}` : "";
    return `<tr><td><strong>${escapeHtml(company.name)}</strong><br><small>${escapeHtml(names.get(company.connector) ?? company.connector)} · ${escapeHtml(company.slug)}${company.query ? ` · busca “${escapeHtml(company.query)}”` : ""}</small></td><td><span class="status-pill ${tone}">${escapeHtml(statusText)}</span>${detail ? `<br><small>${escapeHtml(detail)}</small>` : ""}</td><td><span class="status-pill ${company.enabled ? "teal" : "neutral"}">${company.enabled ? "Ativa" : "Pausada"}</span></td><td><button class="secondary-button" data-connector-toggle="${escapeHtml(company.id)}" data-enabled="${company.enabled ? "1" : "0"}">${company.enabled ? "Pausar" : "Ativar"}</button> <button class="text-button danger-text" data-connector-delete="${escapeHtml(company.id)}" data-name="${escapeHtml(company.name)}">Remover</button></td></tr>`;
  }).join("");
  const options = connectors.map((connector) => `<option value="${escapeHtml(connector.id)}" data-hint="${escapeHtml(connector.slug_hint)}">${escapeHtml(connector.name)}</option>`).join("");
  return `<table class="source-table"><thead><tr><th>Empresa</th><th>Última coleta</th><th>Estado</th><th><span class="visually-hidden">Ações</span></th></tr></thead><tbody>${rows || `<tr><td colspan="4">Nenhuma empresa cadastrada.</td></tr>`}</tbody></table>
    <form data-connector-form class="form-grid section-spaced"><div class="form-field"><label for="connector-id">Conector</label><select class="select" id="connector-id" name="connector">${options}</select></div><div class="form-field"><label for="connector-slug">Identificador no ATS <span class="required" aria-hidden="true">*</span></label><input class="input" id="connector-slug" name="slug" required autocomplete="off" spellcheck="false" aria-describedby="connector-slug-hint" /><small id="connector-slug-hint">${escapeHtml(connectors[0]?.slug_hint ?? "")}</small></div><div class="form-field"><label for="connector-name">Nome da empresa</label><input class="input" id="connector-name" name="name" autocomplete="off" /></div><div class="form-field"><label for="connector-query">Termo de busca (só Gupy)</label><input class="input" id="connector-query" name="query" autocomplete="off" placeholder="Ex.: analista de dados" /></div><div class="form-field full"><button class="primary-button" type="submit"><span aria-hidden="true">+</span> Adicionar empresa</button></div></form>`;
}

export async function mountConnectorPanel(root: ParentNode, deps: ConnectorPanelDeps): Promise<void> {
  const section = root.querySelector<HTMLElement>("[data-connector-panel]");
  if (!section || section.dataset.mounted) return;
  section.dataset.mounted = "1";
  const body = section.querySelector<HTMLElement>("[data-connector-body]")!;
  const refresh = async () => {
    try {
      const data = await deps.fetchJson<{ connectors: ConnectorDefinition[]; companies: ConnectorCompany[] }>("/api/connectors");
      body.innerHTML = renderBody(deps, data.connectors, data.companies);
    } catch (error) {
      body.innerHTML = `<p>${deps.escapeHtml(error instanceof Error ? error.message : "Não foi possível carregar as empresas.")}</p>`;
    } finally {
      section.removeAttribute("aria-busy");
    }
  };
  // Eventos tratados aqui não sobem para os handlers globais da página.
  section.addEventListener("change", (event) => {
    const select = (event.target as HTMLElement).closest<HTMLSelectElement>("#connector-id");
    const hint = section.querySelector<HTMLElement>("#connector-slug-hint");
    if (select && hint) hint.textContent = select.selectedOptions[0]?.dataset.hint ?? "";
  });
  section.addEventListener("submit", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const form = event.target as HTMLFormElement;
    const data = new FormData(form);
    const value = (name: string) => String(data.get(name) ?? "").trim();
    void deps.fetchJson("/api/connectors/companies", { method: "POST", body: JSON.stringify({ connector: value("connector"), slug: value("slug"), name: value("name") || value("slug"), query: value("query") }) })
      .then(async () => { await refresh(); deps.toast("Empresa adicionada à coleta automática."); })
      .catch((error) => deps.toast(error instanceof Error ? error.message : "Falha ao salvar", true));
  });
  section.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const toggle = target.closest<HTMLElement>("[data-connector-toggle]");
    const remove = target.closest<HTMLElement>("[data-connector-delete]");
    if (!toggle && !remove) return;
    event.stopPropagation();
    void (async () => {
      if (toggle) {
        await deps.fetchJson(`/api/connectors/companies/${encodeURIComponent(toggle.dataset.connectorToggle ?? "")}`, { method: "PATCH", body: JSON.stringify({ enabled: toggle.dataset.enabled !== "1" }) });
      } else if (remove) {
        if (!await deps.confirm("Remover empresa?", `“${remove.dataset.name ?? ""}” sai da coleta automática. As vagas já coletadas continuam no painel.`, "Remover", true)) return;
        await deps.fetchJson(`/api/connectors/companies/${encodeURIComponent(remove.dataset.connectorDelete ?? "")}`, { method: "DELETE" });
      }
      await refresh();
    })().catch((error) => deps.toast(error instanceof Error ? error.message : "Falha na operação", true));
  });
  await refresh();
}
