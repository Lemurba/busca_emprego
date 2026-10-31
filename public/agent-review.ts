// Publicação revisada de agentes (auditoria 2026-10-30 §2 item 3): antes de publicar, o painel
// mostra o que muda em relação à versão publicada e de onde veio o rascunho (edição humana,
// proposta do coordenador ou token de serviço). A publicação envia o `checksum` da versão
// revisada; o servidor recusa publicar proposta que não seja humana sem ele. A marcação é string
// (o modal de app.ts), e as ações chegam pela delegação de cliques do #view/modal.

export type AgentVersionChange = { field: string; before: unknown; after: unknown };
export type AgentVersionDiff = {
  agent_id: string; version_id: string; version: number; status: string; checksum: string; created_by: string; created_at: string;
  origin: "human" | "coordinator" | "service"; proposal_reason: string | null; published: { version_id: string; version: number } | null;
  changes: AgentVersionChange[];
};

export type AgentReviewDeps = {
  escapeHtml: (value: unknown) => string;
  fetchJson: <T>(url: string, options?: RequestInit) => Promise<T>;
  openModal: (title: string, subtitle: string, content: string) => void;
  closeModal: () => void;
  modalRoot: () => HTMLElement;
  confirmDialog: (title: string, message: string, confirmLabel: string, danger?: boolean) => Promise<boolean>;
  reload: () => Promise<void>;
  toast: (message: string, error?: boolean) => void;
  formatDate: (value: string | null | undefined) => string;
  actorLabel: (actor: string) => string;
  agentName: (agentId: string) => string;
  fieldLabel: (field: string) => string;
};

const originLabels: Record<AgentVersionDiff["origin"], [string, string]> = {
  human: ["Editada por você", "teal"],
  coordinator: ["Proposta do coordenador", "orange"],
  service: ["Enviada por automação", "orange"]
};

/** Rótulos dos campos do snapshot de configuração (src/db/agent-configs.ts → configSnapshot). */
const configFieldLabels: Record<string, string> = {
  name: "Nome", description: "Descrição", role_type: "Papel", enabled: "Ativo", source_ids: "Fontes", allowed_domains: "Domínios permitidos",
  tool_scopes: "Ferramentas liberadas", browser_enabled: "Lê páginas no navegador", can_create_jobs: "Adiciona vagas", can_edit_jobs: "Completa dados de vagas",
  editable_fields: "Campos que pode alterar", concurrency: "Tarefas em paralelo", timeout_seconds: "Tempo limite (segundos)", prompt: "Instruções",
  memory_enabled: "Memória do Hermes", hermes_prompt_optimization: "Sugestões de melhoria", model_id: "Modelo", reasoning_effort: "Esforço de raciocínio",
  max_input_tokens: "Máximo de tokens de entrada", max_output_tokens: "Máximo de tokens de saída", max_cost_per_run: "Custo máximo por execução",
  fallback_policy: "Modelo reserva", structured_output_required: "Exige saída estruturada"
};

type DiffLine = { type: "same" | "add" | "del"; text: string };

/**
 * Diferença por linhas (maior subsequência comum). Instruções têm no máximo 12.000 caracteres;
 * acima de ~250 mil comparações, cai para "tudo removido / tudo adicionado".
 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length * b.length > 250_000) return [...a.map((text) => ({ type: "del" as const, text })), ...b.map((text) => ({ type: "add" as const, text }))];
  const table = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { lines.push({ type: "same", text: a[i]! }); i++; j++; }
    else if (table[i + 1]![j]! >= table[i]![j + 1]!) lines.push({ type: "del", text: a[i++]! });
    else lines.push({ type: "add", text: b[j++]! });
  }
  while (i < a.length) lines.push({ type: "del", text: a[i++]! });
  while (j < b.length) lines.push({ type: "add", text: b[j++]! });
  return lines;
}

function displayValue(value: unknown, deps: AgentReviewDeps, field: string) {
  if (value == null || value === "") return "—";
  if (typeof value === "boolean") return value ? "Sim" : "Não";
  if (Array.isArray(value)) return value.map((item) => field === "editable_fields" ? deps.fieldLabel(String(item)) : String(item)).join(", ") || "—";
  return String(value);
}

function promptDiffHtml(change: AgentVersionChange, deps: AgentReviewDeps) {
  const lines = lineDiff(String(change.before ?? ""), String(change.after ?? ""));
  const marks = { same: " ", add: "+", del: "−" } as const;
  const labels = { same: "", add: "Linha adicionada: ", del: "Linha removida: " } as const;
  // Região rolável com foco pelo teclado (axe: scrollable-region-focusable).
  return `<div class="prompt-diff" role="region" aria-label="Diferença nas instruções" tabindex="0"><pre>${lines.map((line) => `<span class="diff-line ${line.type}"><span class="visually-hidden">${labels[line.type]}</span><span aria-hidden="true">${marks[line.type]} </span>${deps.escapeHtml(line.text) || " "}</span>`).join("\n")}</pre></div>`;
}

/** Abre o modal de revisão: origem, justificativa da proposta e diferença campo a campo. */
export async function showAgentPublishReview(agentId: string, versionId: string, deps: AgentReviewDeps) {
  const { escapeHtml } = deps;
  const diff = await deps.fetchJson<AgentVersionDiff>(`/api/agents/${encodeURIComponent(agentId)}/versions/${encodeURIComponent(versionId)}/diff`);
  const [originText, originTone] = originLabels[diff.origin] ?? originLabels.service;
  const reviewed = diff.origin === "human";
  const rows = diff.changes.filter((change) => change.field !== "prompt").map((change) => `<tr><th scope="row">${escapeHtml(configFieldLabels[change.field] ?? change.field)}</th><td data-label="Publicado hoje">${escapeHtml(displayValue(change.before, deps, change.field))}</td><td data-label="Nesta versão"><strong>${escapeHtml(displayValue(change.after, deps, change.field))}</strong></td></tr>`).join("");
  const prompt = diff.changes.find((change) => change.field === "prompt");
  const content = `
    <div class="publish-review" data-publish-review="${escapeHtml(agentId)}">
      <p class="publish-origin"><span class="status-pill ${originTone}">${escapeHtml(originText)}</span> <span class="muted-text">${reviewed ? "" : `por ${escapeHtml(deps.actorLabel(diff.created_by))} · `}${escapeHtml(deps.formatDate(diff.created_at))}</span></p>
      ${reviewed ? "" : `<div class="notice warning" role="note"><div><strong>Esta versão não foi escrita por você.</strong> Leia cada mudança, principalmente as instruções, antes de publicar. Se algo parecer estranho, descarte o rascunho.${diff.proposal_reason ? `<br>Justificativa do coordenador: “${escapeHtml(diff.proposal_reason)}”` : ""}</div></div>`}
      ${diff.changes.length ? "" : `<p class="muted-text">Nenhuma diferença em relação à versão publicada.</p>`}
      ${rows ? `<div class="table-wrap flat" role="region" aria-label="Campos alterados" tabindex="0"><table class="data-table responsive-table diff-table"><caption class="visually-hidden">Campos alterados</caption><thead><tr><th scope="col">Campo</th><th scope="col">Publicado hoje${diff.published ? ` (v${diff.published.version})` : ""}</th><th scope="col">Nesta versão (v${diff.version})</th></tr></thead><tbody>${rows}</tbody></table></div>` : ""}
      ${prompt ? `<section class="detail-section"><h3>Instruções</h3>${promptDiffHtml(prompt, deps)}</section>` : ""}
      ${reviewed ? "" : `<label class="setting-toggle"><span><strong>Revisei as mudanças</strong><small>Confirme que leu a proposta inteira.</small></span><input type="checkbox" data-publish-reviewed /></label>`}
      <div class="modal-actions">
        <button type="button" class="danger-button action-left" data-discard-agent-draft="${escapeHtml(agentId)}" data-version-id="${escapeHtml(diff.version_id)}">Descartar rascunho</button>
        <button type="button" class="secondary-button" data-close-modal>Cancelar</button>
        <button type="button" class="primary-button" data-confirm-publish-agent="${escapeHtml(agentId)}" data-version-id="${escapeHtml(diff.version_id)}" data-checksum="${escapeHtml(diff.checksum)}" ${reviewed ? "" : "disabled"}>Publicar versão ${diff.version}</button>
      </div>
    </div>`;
  deps.openModal(`Publicar ${deps.agentName(agentId)}?`, "A nova versão passa a valer nas próximas execuções. As anteriores ficam no histórico.", content);
  const root = deps.modalRoot();
  const checkbox = root.querySelector<HTMLInputElement>("[data-publish-reviewed]");
  const publish = root.querySelector<HTMLButtonElement>("[data-confirm-publish-agent]");
  checkbox?.addEventListener("change", () => { if (publish) publish.disabled = !checkbox.checked; });
}

/** Ações do fluxo de publicação; devolve true quando o clique era deste módulo. */
export async function handleAgentReviewAction(target: HTMLElement, deps: AgentReviewDeps): Promise<boolean> {
  const open = target.closest<HTMLElement>("[data-publish-agent]");
  if (open?.dataset.publishAgent && open.dataset.versionId) {
    await showAgentPublishReview(open.dataset.publishAgent, open.dataset.versionId, deps);
    return true;
  }
  const confirm = target.closest<HTMLElement>("[data-confirm-publish-agent]");
  if (confirm?.dataset.confirmPublishAgent && confirm.dataset.versionId) {
    await deps.fetchJson(`/api/agents/${encodeURIComponent(confirm.dataset.confirmPublishAgent)}/publish`, { method: "POST", body: JSON.stringify({ version_id: confirm.dataset.versionId, checksum: confirm.dataset.checksum }) });
    deps.closeModal();
    await deps.reload();
    deps.toast("Nova versão do agente publicada.");
    return true;
  }
  const discard = target.closest<HTMLElement>("[data-discard-agent-draft]");
  if (discard?.dataset.discardAgentDraft && discard.dataset.versionId) {
    if (!await deps.confirmDialog("Descartar este rascunho?", "A versão publicada continua valendo. O rascunho fica no histórico como substituído e não pode ser publicado.", "Descartar", true)) return true;
    await deps.fetchJson(`/api/agents/${encodeURIComponent(discard.dataset.discardAgentDraft)}/discard-draft`, { method: "POST", body: JSON.stringify({ version_id: discard.dataset.versionId }) });
    deps.closeModal();
    await deps.reload();
    deps.toast("Rascunho descartado.");
    return true;
  }
  return false;
}
