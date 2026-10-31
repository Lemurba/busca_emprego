// Ações da página "Saúde das buscas" que dependem de você (auditoria 2026-10-30 §2 item 5 e
// §4.3 F24): responder pelo painel uma pergunta do executor (inclusive a que não chegou ao
// Telegram) e decidir/desfazer uma possível duplicata. A marcação está em Preact
// (public/ui/pages/operations-page.tsx); aqui ficam as ações delegadas por `data-*`.

export type HumanQuestion = {
  id: string; application_id: string; question: string; status: string; required: boolean; choices: string[];
  uncertainty_reason?: string | null; step?: string | null; sanitized_delivery_error?: string | null;
};

export type OpsActionDeps = {
  escapeHtml: (value: unknown) => string;
  fetchJson: <T>(url: string, options?: RequestInit) => Promise<T>;
  openDialog: (options: { title: string; body: string; confirmLabel: string; danger?: boolean; validate?: (form: HTMLFormElement) => string | null }) => Promise<FormData | null>;
  confirmDialog: (title: string, message: string, confirmLabel: string, danger?: boolean) => Promise<boolean>;
  reload: () => Promise<void>;
  toast: (message: string, error?: boolean, action?: { label: string; run: () => Promise<void> }) => void;
  question: (id: string) => HumanQuestion | undefined;
  questionContext: (question: HumanQuestion) => string;
};

/** Horas que a decisão sobre uma duplicata pode ser desfeita (DUPLICATE_UNDO_WINDOW_MS no servidor). */
export const DUPLICATE_UNDO_HOURS = 24;

async function undoDuplicate(id: string, deps: OpsActionDeps) {
  await deps.fetchJson(`/api/possible-duplicates/${encodeURIComponent(id)}/undo`, { method: "POST", body: "{}" });
  await deps.reload();
  deps.toast("Decisão desfeita: a possível duplicata voltou para a fila.");
}

function answerDialogBody(question: HumanQuestion, deps: OpsActionDeps) {
  const { escapeHtml } = deps;
  const options: [string, string, string][] = [
    ["answer", "Responder", "A automação continua com a sua resposta."],
    ...(!question.required ? [["skip", "Pular", "Pergunta opcional: a automação segue sem a resposta."] as [string, string, string]] : []),
    ["manual", "Seguir manualmente", "Revoga o envio automático; você envia pelo portal."],
    ["stop", "Parar esta candidatura", "Revoga o envio automático e encerra a execução."]
  ];
  return `
    <p><strong>${escapeHtml(question.question)}</strong></p>
    <p class="muted-text">${escapeHtml(deps.questionContext(question))}</p>
    ${question.uncertainty_reason ? `<p class="muted-text">Por que o agente perguntou: ${escapeHtml(question.uncertainty_reason)}</p>` : ""}
    ${question.status === "delivery_failed" ? `<div class="notice warning" role="note"><div>A mensagem não chegou ao Telegram${question.sanitized_delivery_error ? ` (${escapeHtml(question.sanitized_delivery_error)})` : ""}. A resposta dada aqui vale do mesmo jeito.</div></div>` : ""}
    <fieldset class="choice-group"><legend>O que fazer</legend>${options.map(([value, text, hint], index) => `<label class="choice"><input type="radio" name="action" value="${value}" ${index === 0 ? "checked" : ""} /><span><strong>${text}</strong><small>${hint}</small></span></label>`).join("")}</fieldset>
    <div class="form-field"><label for="question-answer">Resposta</label><input class="input" id="question-answer" name="answer" maxlength="1000" autocomplete="off" ${question.choices.length ? `list="question-choices"` : ""} />${question.choices.length ? `<datalist id="question-choices">${question.choices.map((choice) => `<option value="${escapeHtml(choice)}"></option>`).join("")}</datalist><small>Sugestões do agente: ${escapeHtml(question.choices.join(", "))}.</small>` : ""}</div>`;
}

/** Trata os botões desta área; devolve true quando a ação era deste módulo. */
export async function handleOpsAction(target: HTMLElement, deps: OpsActionDeps): Promise<boolean> {
  const answer = target.closest<HTMLElement>("[data-answer-question]")?.dataset.answerQuestion;
  if (answer) {
    const question = deps.question(answer);
    if (!question) { deps.toast("Esta pergunta não está mais pendente.", true); await deps.reload(); return true; }
    const form = await deps.openDialog({
      title: "Responder pelo painel",
      body: answerDialogBody(question, deps),
      confirmLabel: "Enviar resposta",
      validate: (element) => {
        const data = new FormData(element);
        return data.get("action") === "answer" && !String(data.get("answer") ?? "").trim() ? "Escreva a resposta ou escolha outra opção." : null;
      }
    });
    if (!form) return true;
    const action = String(form.get("action") ?? "answer");
    const body = action === "answer" ? { action, answer: String(form.get("answer") ?? "").trim() } : { action };
    await deps.fetchJson(`/api/human-questions/${encodeURIComponent(question.id)}/respond`, { method: "POST", body: JSON.stringify(body) });
    await deps.reload();
    deps.toast(action === "answer" || action === "skip" ? "Resposta registrada; a automação foi retomada." : action === "manual" ? "Candidatura passou para envio manual." : "Candidatura interrompida.");
    return true;
  }
  const duplicate = target.closest<HTMLElement>("[data-resolve-duplicate]");
  if (duplicate?.dataset.resolveDuplicate && duplicate.dataset.resolution) {
    const id = duplicate.dataset.resolveDuplicate;
    const merged = duplicate.dataset.resolution === "merged";
    if (merged && !await deps.confirmDialog("Mesclar as duas vagas?", `Elas passam a ser tratadas como a mesma vaga. Nenhuma vaga é apagada, e você pode desfazer a decisão por ${DUPLICATE_UNDO_HOURS} horas (aqui ou em “Decididas recentemente”).`, "Mesclar")) return true;
    await deps.fetchJson(`/api/possible-duplicates/${encodeURIComponent(id)}/resolve`, { method: "POST", body: JSON.stringify({ status: duplicate.dataset.resolution }) });
    await deps.reload();
    deps.toast(merged ? "Vagas mescladas." : "Decisão registrada.", false, { label: "Desfazer", run: () => undoDuplicate(id, deps) });
    return true;
  }
  const undo = target.closest<HTMLElement>("[data-undo-duplicate]")?.dataset.undoDuplicate;
  if (undo) {
    await undoDuplicate(undo, deps);
    return true;
  }
  return false;
}
