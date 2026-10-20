// Erros de domínio do Radar (issue #29): um único tipo `DomainError(code, status, details)`.
// O núcleo (db/domain/workflow) lança códigos estáveis; as bordas HTTP e MCP decidem status
// e mensagem só pelo `code`, com textos pt-BR vindos do dicionário abaixo. Mudar a redação
// de uma mensagem nunca muda o status.

export class DomainError extends Error {
  readonly status: number;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    readonly code: string,
    status?: number,
    details?: Readonly<Record<string, unknown>>,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "DomainError";
    this.status = status ?? statusForCode(code);
    this.details = details;
  }
}

/** Status por código: regras na ordem; a primeira que casar vence. Sem regra → 400. */
const STATUS_RULES: Array<[RegExp, number]> = [
  [/^AUTOMATION_DISABLED$/u, 403],
  // #32: limite diário de envios automáticos.
  [/^application\.daily_limit_reached$/u, 429],
  [/^PDF_DUPLICATE$/u, 409],
  [/^PDF_TOO_LARGE$/u, 413],
  [/^VERSION_CONFLICT$|^ILLEGAL_TRANSITION$/u, 409],
  [/^PRECONDITION_FAILED$|^INVALID_COMMAND$/u, 422],
  [/\.forbidden$|\.internal_route_required$/u, 403],
  [/(?:^|\.)not_found$/u, 404],
  [/version_conflict|\.race$|\.already_active$/u, 409],
  [/^resume\.unverified_facts$/u, 409],
  [/^resume\.pdf_parse_failed$/u, 409],
  [/^validation\./u, 422],
  [/^(?:PDF|PROFILE|ATS|ROUND|BASE_RESUME|SUBMISSION|SCHEMA_INVALID)_?/u, 422],
  [/^(?:feedback|human_question|preference_rule|workflow|agent|job|round|source|possible_duplicate|application|resume|base_resume|profile|field_conflict|decision)\./u, 422],
];

export function statusForCode(code: string): number {
  const base = code.split(":")[0] ?? code;
  return STATUS_RULES.find(([pattern]) => pattern.test(base))?.[1] ?? 400;
}

/** Dicionário pt-BR de mensagens ao usuário, por código estável. */
export const ERROR_MESSAGES: Record<string, string> = {
  unauthorized: "Sessão ausente ou expirada. Abra o link de acesso enviado pelo Hermes.",
  internal_token_required: "Esta rota aceita somente o token de serviço interno.",
  internal_token_not_configured: "O token de serviço interno não está configurado no servidor.",
  internal_error: "Erro interno. Tente novamente; se persistir, consulte o log do servidor.",
  AUTOMATION_DISABLED: "A candidatura automatizada está desligada nesta instalação (variável de ambiente ou kill-switch do painel).",
  // #32 — executor: ATS de empresa, dry-run com confirmação final, limite diário.
  "application.domain.not_ats": "O link de candidatura não é de um ATS de empresa permitido para envio automático. Use “Enviar manualmente”.",
  "application.final_confirmation_required": "O envio final exige a sua confirmação no painel (ENVIAR) e o token de envio dessa confirmação.",
  "application.final_confirmation.not_pending": "Não há confirmação final pendente para esta candidatura.",
  "application.final_confirmation.text_required": "Confirme digitando ENVIAR.",
  "application.daily_limit_reached": "O limite diário de envios automáticos foi atingido; a candidatura voltou para revisão.",
  "application.observed_url.required": "Informe a URL observada no portal.",
  "application.evidence.screenshot_invalid": "A captura de tela precisa ser um PNG válido em base64.",
  "application.evidence.screenshot_too_large": "A captura de tela deve ter no máximo 2 MB.",
  "application.evidence.fields_invalid": "Resumo dos campos inválido (até 100 itens com rótulo e valor curtos).",
  "settings.automation.empty": "Nenhuma configuração de automação informada.",
  not_found: "Recurso não encontrado.",
  not_implemented: "Operação ainda não disponível nesta versão do servidor.",
  PDF_DUPLICATE: "Este PDF já está na biblioteca.",
  PDF_TOO_LARGE: "O PDF deve ter no máximo 5 MB.",
  PDF_MIME_INVALID: "Envie um arquivo PDF.",
  PDF_SIGNATURE_INVALID: "O arquivo enviado não parece ser um PDF válido.",
  "workflow.version_conflict": "A vaga foi alterada em outra tela. Atualize e tente de novo.",
  "application.url_mismatch": "A URL observada não corresponde à URL autorizada.",
  "application.url.insecure": "A candidatura automática exige que a URL de candidatura use HTTPS.",
  "application.url.required": "A vaga não tem URL de candidatura.",
  "job.archived": "Esta vaga foi excluída. Restaure-a antes de alterá-la.",
  "job.not_archived": "Esta vaga não está excluída.",
  "job.not_suppressed": "Esta vaga não está oculta.",
  "job.deadline.invalid": "Prazo inválido: use AAAA-MM-DD ou data-hora ISO 8601 com fuso.",
  "job.archive.confirmation_required": "Confirme a exclusão com EXCLUIR.",
  "job.liveness.stale": "Verifique se a vaga ainda está aberta (Verificar agora) antes de autorizar: a última confirmação tem mais de 24 h ou não indicou vaga aberta.",
  "job.closed": "Vaga encerrada na fonte: não avalie vagas fechadas.",
  "job.archive.application_in_progress": "A candidatura desta vaga está sendo enviada agora; aguarde antes de excluir.",
  "decision.undo.nothing_to_undo": "Não há decisão para desfazer nesta vaga.",
  "decision.undo.application_locked": "A decisão não pode ser desfeita: a candidatura está em andamento ou já foi enviada.",
  "decision.undo.interest_has_progress": "O interesse já gerou currículo ou candidatura; use “Não tenho interesse” para sair do fluxo.",
  "decision.undo.feedback_not_found": "Esse registro já foi desfeito ou não pertence a esta vaga.",
  "decision.undo.use_current_decision": "Para desfazer o descarte, desfaça a decisão atual da vaga.",
  "decision.undo.not_undoable": "Esta decisão reflete o estado da vaga e não pode ser desfeita.",
  "preference_rule.undone": "Esta regra foi desfeita junto com o feedback que a criou e não pode ser reativada.",
  "application.internal_route_required": "Envios automáticos só podem ser registrados pelo executor autorizado.",
  "human_question.identity_unauthorized": "Resposta recebida de uma identidade não vinculada ao Radar.",
  "human_question.reply_not_correlated": "A resposta não corresponde à pergunta enviada.",
  "resume.unverified_facts": "O currículo tem fatos novos sem confirmação. Confirme, corrija ou remova cada um antes de aprovar.",
  "resume.fact.not_found": "Esse fato não existe na versão atual do currículo.",
  "resume.fact.stale": "O currículo mudou desde a checagem. Atualize e tente de novo.",
  "resume.fact.replacement_required": "Informe o texto correto (até 500 caracteres).",
  "resume.fact.already_resolved": "Esse fato já foi resolvido.",
  "resume.fact.approved_locked": "Retorne o currículo aprovado para revisão antes de alterá-lo.",
  "resume.pdf_parse_failed": "O teste de leitura do PDF falhou: um parser não enxerga parte do currículo. Corrija o conteúdo; a justificativa de exceção não libera esse bloqueio.",
  "job.requirements_json.invalid": "Exigências explícitas inválidas: cada exigência precisa do trecho literal do anúncio em evidence.",
  "profile.import.invalid": "O arquivo não é um JSON Resume válido.",
  "profile.import.empty": "O JSON Resume não tem nenhuma informação que o Radar saiba importar.",
};

export const DEFAULT_REJECTION_MESSAGE = "A operação foi recusada pelas regras do Radar.";

/** Mensagem pt-BR para um código (com ou sem sufixo `:detalhe`). */
export function messageForCode(code: string, fallback = DEFAULT_REJECTION_MESSAGE): string {
  const base = code.split(":")[0] ?? code;
  return ERROR_MESSAGES[code] ?? ERROR_MESSAGES[base] ?? fallback;
}

/** Mensagem segura de um `DomainError`: dicionário primeiro; senão o texto pt-BR do próprio erro. */
export function userMessage(error: DomainError): string {
  return messageForCode(error.code, error.message && error.message !== error.code ? error.message : DEFAULT_REJECTION_MESSAGE);
}

/** Código estável lançado como `new Error("job.salary.invalid:min")` (formato legado). */
const STABLE_CODE = /^(?:[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+|[A-Z][A-Z0-9_]+)(?::[A-Za-z0-9_.,:-]{0,200})?$/u;

/**
 * Normaliza erros do domínio para `DomainError`: a própria classe (e subclasses, como
 * `DomainValidationError` e `WorkflowError`) passa direto; `Error` puro cuja mensagem é um
 * código estável (formato legado de src/db.ts) é convertido. Qualquer outra coisa → null
 * (a borda decide: frase pt-BR legada ou 500).
 */
export function toDomainError(error: unknown): DomainError | null {
  if (error instanceof DomainError) return error;
  if (error instanceof Error && error.constructor === Error && !("code" in error)) {
    const raw = error.message.trim();
    if (!STABLE_CODE.test(raw)) return null;
    // O código mantém o sufixo (`job.salary.invalid:min`) por compatibilidade com clientes.
    const suffix = raw.includes(":") ? raw.slice(raw.indexOf(":") + 1) : "";
    return new DomainError(raw, statusForCode(raw), suffix ? { reason: suffix } : undefined);
  }
  return null;
}
