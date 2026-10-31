// Erros de domínio do Radar (issue #29): um único tipo `DomainError(code, status, message, details)`.
// O núcleo (src/db/, domain, workflow, conectores) lança só códigos estáveis; as bordas HTTP e MCP
// decidem status e mensagem pelo `code` (nunca pelo texto), com textos pt-BR vindos do dicionário
// abaixo. Mudar a redação de uma mensagem nunca muda o status. Qualquer outro erro (Error puro,
// invariante interna, falha do SQLite) vira 500 `internal_error` e só aparece no log.

export class DomainError extends Error {
  readonly status: number;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  /**
   * `status` explícito vence a tabela STATUS_RULES. `code` pode trazer um sufixo de detalhe
   * (`job.salary.invalid:min`): ele fica no código, por compatibilidade com os clientes, e vai
   * para `details.reason` quando nenhum detalhe é informado.
   */
  constructor(
    readonly code: string,
    status?: number,
    message?: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message ?? code);
    this.name = "DomainError";
    this.status = status ?? statusForCode(code);
    const suffix = code.includes(":") ? code.slice(code.indexOf(":") + 1) : "";
    this.details = details ?? (suffix ? { reason: suffix } : undefined);
  }
}

/**
 * Status por código (a parte antes de `:`): regras na ordem, a primeira que casar vence; sem
 * regra → 400. É a tabela dos códigos estáveis, não uma leitura da mensagem.
 */
const STATUS_RULES: Array<[RegExp, number]> = [
  [/^AUTOMATION_DISABLED$/u, 403],
  // #32: limite diário de envios automáticos.
  [/^application\.daily_limit_reached$/u, 429],
  // #16: limite de execuções simultâneas do agente (tente de novo quando uma terminar).
  [/^agent\.run\.concurrency_exceeded$/u, 429],
  [/^agent\.run\.(?:timeout|aborted|not_reopenable)$|^agent\.version\.(?:review_required|stale)$|^connector\.enrichment\.already_resolved$|^possible_duplicate\.undo_expired$/u, 409],
  [/^PDF_DUPLICATE$/u, 409],
  [/^PDF_TOO_LARGE$/u, 413],
  [/^VERSION_CONFLICT$|^ILLEGAL_TRANSITION$/u, 409],
  [/^PRECONDITION_FAILED$|^INVALID_COMMAND$/u, 422],
  [/\.forbidden$|\.internal_route_required$/u, 403],
  [/(?:^|\.)not_found$/u, 404],
  [/version_conflict|\.race$|\.already_active$/u, 409],
  [/^resume\.unverified_facts$/u, 409],
  // #49: já há um rascunho de perfil aberto (nova versão espera o atual ser confirmado ou descartado).
  [/^profile\.draft_exists$/u, 409],
  // #49: rascunho mais velho que o perfil ativo (confirmá-lo desfaria a versão nova).
  [/^profile\.draft_stale$/u, 409],
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
  "application.authorization.unavailable": "Autorização indisponível, expirada, já usada ou desatualizada.",
  "agent_run.agent_mismatch": "A execução pertence a outro agente.",
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
  "source.smoke_test.manual_only": "Esta fonte é coletada por agentes no Hermes: registre o resultado do teste de acesso manualmente.",
  "source.smoke_test.company_required": "Cadastre e ative ao menos uma empresa deste conector antes de testar o acesso.",
  "resume.superseded": "Este rascunho foi substituído por um currículo gerado depois para a mesma vaga.",
  "resume.pdf_parse_failed": "O teste de leitura do PDF falhou: um parser não enxerga parte do currículo. Corrija o conteúdo; a justificativa de exceção não libera esse bloqueio.",
  "job.requirements_json.invalid": "Exigências explícitas inválidas: cada exigência precisa do trecho literal do anúncio em evidence.",
  "profile.import.invalid": "O arquivo não é um JSON Resume válido.",
  "profile.import.empty": "O JSON Resume não tem nenhuma informação que o Radar saiba importar.",
  // Perfil profissional (#49, QA-04/TD-07, I49-09/I49-11).
  "profile.fact.invalid": "Informação do perfil inválida: informe o tipo (até 80 caracteres) e um valor; listas aceitam só textos, números ou sim/não.",
  "profile.interview.invalid": "Resposta inválida: informe a pergunta e um valor; listas aceitam só textos, números ou sim/não.",
  "profile.fact.review.forbidden": "Revisar informações do perfil é decisão humana: use o dashboard.",
  "profile.confirm.forbidden": "Confirmar o perfil é decisão humana: use o dashboard.",
  // Agentes (#16 e publicação revisada).
  "agent.run.concurrency_exceeded": "O agente já está no limite de execuções simultâneas; espere uma terminar.",
  "agent.run.timeout": "A execução passou do tempo limite do agente e foi interrompida.",
  "agent.run.aborted": "A execução foi interrompida por exceder um limite do agente e não pode ser retomada.",
  "agent.run.not_reopenable": "Esta execução já terminou e não pode voltar a rodar; registre uma execução nova.",
  "agent.run.max_cost_exceeded": "A execução passou do custo máximo por execução do agente e foi interrompida.",
  "agent.run.max_input_tokens_exceeded": "A execução passou do limite de tokens de entrada do agente e foi interrompida.",
  "agent.run.max_output_tokens_exceeded": "A execução passou do limite de tokens de saída do agente e foi interrompida.",
  "agent.version.review_required": "Revise as diferenças desta versão antes de publicar (o rascunho pode ter mudado desde a revisão).",
  "agent.version.not_draft": "Esta versão não é mais um rascunho.",
  "agent.version.stale": "Esta versão não é mais o rascunho atual do agente: chegou uma alteração ou proposta mais nova. Revise o rascunho atual.",
  "agent.version.not_restorable": "Só versões que já estiveram publicadas podem ser restauradas; revise o rascunho para publicá-lo.",
  "connector.enrichment.already_resolved": "Este item da fila de enriquecimento já foi fechado.",
  "human_question.not_active": "Esta pergunta já foi respondida ou cancelada.",
  "human_question.answer.invalid": "Escreva a resposta (até 1.000 caracteres).",
  "human_question.required_cannot_skip": "Esta pergunta é obrigatória: responda, siga manualmente ou pare a execução.",
  "possible_duplicate.undo_expired": "O prazo para desfazer esta decisão terminou.",
  "possible_duplicate.not_resolved": "Esta possível duplicata ainda não foi decidida.",
  "profile.delete.forbidden": "Descartar um rascunho de perfil é decisão humana: use o dashboard.",
  "profile.new_version.forbidden": "Criar uma nova versão do perfil é decisão humana: use o dashboard.",
  "profile.not_found": "Perfil não encontrado. Atualize a página.",
  "profile.draft_required": "Só um perfil em rascunho pode ser alterado: crie uma nova versão a partir do perfil confirmado.",
  "profile.confirmed_required": "A nova versão parte do perfil confirmado (ativo).",
  "profile.draft_exists": "Já existe um perfil em rascunho: revise-o ou descarte-o antes de criar outra versão.",
  "profile.draft_stale": "Este rascunho é mais antigo que o perfil ativo: descarte-o e crie uma nova versão a partir do perfil ativo.",
  "profile.fact.not_found": "Essa informação não existe neste perfil. Atualize a página.",
  "profile.fact.state.invalid": "Estado ou origem da informação do perfil inválido.",
  "profile.fact.evidence.required": "Esta informação precisa de evidência (página ou trecho) para ser confirmada.",
  "profile.fact.confidence.invalid": "Confiança da informação do perfil inválida: use um número de 0 a 1.",
  "profile.source.invalid": "Origem do perfil inválida.",
  PROFILE_FACTS_UNCONFIRMED: "Ainda há informações do perfil a revisar: confirme ou rejeite cada uma antes de confirmar o perfil.",
  PROFILE_EMPTY: "O perfil ainda não tem nenhuma informação confirmada.",
  PROFILE_CONFIRMATION_REQUIRED: "Confirme o perfil profissional no dashboard antes de continuar.",
  BASE_RESUME_EXTRACTION_REQUIRED: "O texto do currículo-base não foi extraído: envie um PDF com texto selecionável (não digitalizado como imagem).",
  "base_resume.not_found": "Currículo-base não encontrado. Atualize a página.",
  "base_resume.required": "Escolha um currículo-base em PDF (ou use um perfil importado de JSON Resume).",
  PROFILE_SNAPSHOT_REQUIRED: "Confirme o perfil profissional antes: a nota e o currículo usam a versão confirmada do perfil.",
  PROFILE_CONTEXT_TOO_LARGE: "O contexto do perfil passou do tamanho máximo: resuma as informações e tente de novo.",
  PROFILE_SNAPSHOT_INVALID: "A versão do perfil informada não existe neste projeto ou não é a fixada na rodada.",
  // #29: decisões e portões humanos que antes eram frases soltas no núcleo, agora com código.
  "base_resume.upload.invalid": "Informe um nome e um arquivo PDF válido.",
  "job.not_found": "Vaga não encontrada.",
  "application.preconditions_unmet": "Registre interesse e aprove o currículo antes de iniciar uma candidatura.",
  "application.resume.not_approved": "Selecione o currículo aprovado para esta vaga.",
  "application.already_exists": "Já existe uma candidatura para esta vaga.",
  "application.not_found": "Candidatura não encontrada. Atualize a página.",
  "application.manual.preconditions_unmet": "Mantenha o interesse registrado e o currículo aprovado para escolher o modo manual.",
  "application.status.invalid": "Status de candidatura inválido.",
  "application.status.requeue_forbidden": "Uma candidatura em andamento não pode ser recolocada na fila automaticamente.",
  "application.status.review_forbidden": "Esta candidatura não pode voltar para revisão nesta etapa.",
  "application.status.failure_forbidden": "Somente um envio automático autorizado pode ser registrado como falha.",
  "application.status.submission_required": "Registre o envio antes de registrar o resultado da candidatura.",
  "application.resume.locked": "O currículo vinculado não pode ser trocado após a autorização automática.",
  "application.submission.manual_only": "O envio só pode ser registrado no modo manual ou após autorização automática explícita.",
  "application.submission.interest_required": "Registre interesse na vaga antes de confirmar o envio.",
  "application.submission.resume_not_approved": "O currículo vinculado precisa estar aprovado para registrar o envio.",
  "decision.not_interested.feedback_required": "Use o feedback total com categoria e justificativa para rejeitar uma vaga.",
  "decision.confirmation_required": "Confirme explicitamente sua decisão para esta vaga.",
  "decision.reopen_required": "Reabra a vaga com motivo antes de registrar novo interesse.",
  "decision.application_locked": "A decisão não pode ser alterada enquanto a candidatura está em andamento ou já foi enviada.",
  "resume.interest_required": "Registre interesse na vaga antes de preparar o currículo.",
  "resume.approval.human_required": "A aprovação exige confirmação humana explícita.",
  "resume.approved_locked": "Retorne o currículo aprovado para revisão antes de alterá-lo.",
  "resume.application_in_progress": "O currículo não pode ser alterado enquanto a candidatura está em andamento.",
  "resume.approval.confirmation_required": "Digite APROVO para confirmar a revisão deste currículo.",
  "resume.not_found": "Currículo não encontrado. Atualize a página.",
  "resume.approval.interest_required": "A vaga precisa estar marcada como de interesse antes da aprovação.",
  "resume.already_approved": "Este currículo já foi aprovado.",
  "application.authorization.confirmation_required": "Confirme digitando AUTORIZO para esta vaga.",
  "application.authorization.already_granted": "Esta candidatura já recebeu uma autorização automática.",
  "application.authorization.resume_mismatch": "A autorização precisa apontar para o currículo revisado desta vaga.",
  "application.authorization.resume_not_approved": "Aprove o currículo antes de autorizar a candidatura.",
  "application.authorization.preconditions_unmet": "Registre interesse e conclua a revisão do currículo antes de autorizar.",
  "application.authorization.not_awaiting": "A candidatura não está aguardando autorização.",
  "feedback.application_locked": "A rejeição não pode ser registrada enquanto a candidatura está em andamento ou já foi enviada.",
  // #29: códigos sem texto próprio antes (mensagens que o MCP também usa vêm daqui).
  "validation.id.invalid": "Identificador inválido.",
  "agent.not_found": "Agente não encontrado.",
  "agent.jobs.create.forbidden": "O agente não tem permissão para registrar vagas.",
  "agent.jobs.create_existing.forbidden": "A vaga já existe; use o enriquecimento.",
  "agent.jobs.enrich.forbidden": "O agente não tem permissão para enriquecer vagas.",
  "agent.job_field.forbidden": "Campo fora dos campos editáveis do agente.",
  "connector.enrichment.not_found": "Item da fila de enriquecimento não encontrado.",
  "agent.domain.forbidden": "Domínio fora da lista permitida do agente.",
  "agent.source_url.required": "Informe a URL de origem da vaga.",
  "agent.prompt_optimization.disabled": "Otimização de prompt desativada para este agente.",
  "agent.prompt_optimization.reason.invalid": "Motivo da proposta inválido.",
  "agent.prompt_optimization.prompt.invalid": "Prompt proposto inválido ou idêntico ao atual.",
  "job.required_fields.invalid": "Informe título, empresa e fonte da vaga.",
  "SCHEMA_INVALID": "Item do lote fora do esquema (job_url, title e company são obrigatórios; até 25 itens).",
  "ROUND_NO_SOURCES": "A fonte não está configurada ou ativa.",
  "ROUND_SOURCES_NOT_READY": "A fonte não está pronta (termos, autenticação ou smoke test pendentes).",
  "round.not_found": "Rodada não encontrada.",
  "round.not_running": "A rodada já terminou; inicie outra.",
  "round.source.not_found": "A fonte não faz parte da rodada.",
  "round.source.not_runnable": "A fonte já terminou nesta rodada.",
  "agent.published_version.required": "O agente não tem versão publicada.",
  "job.salary.invalid": "Faixa salarial inválida.",
  "job.coordinates.invalid": "Coordenadas inválidas.",
  "application.authorization.required": "A candidatura não tem autorização automática (AUTORIZO).",
  "application.authorization.nonce.required": "Autorização indisponível.",
  "application.worker.required": "Informe o worker_id do executor.",
  "application.claim.required": "A candidatura precisa estar reservada (claim) por este executor.",
  "application.claim.worker_mismatch": "A reserva pertence a outro executor.",
  "application.failure.reason_required": "Informe o motivo da falha.",
  "application.resume_version.changed": "O currículo mudou depois da autorização.",
  "SUBMISSION_EVIDENCE_REQUIRED": "Envio sem evidência observável do portal não é registrado.",
  "human_question.already_active": "Já existe pergunta ativa para esta candidatura.",
  "human_question.invalid": "Pergunta inválida.",
  "human_question.action.invalid": "Ação de resposta inválida.",
  "ATS_CONTENT_NOT_FACTUAL": "O currículo ATS cita algo que não está nas informações confirmadas do perfil.",
  "ATS_KEYWORD_UNSUPPORTED": "Uma palavra-chave do currículo ATS não tem apoio nas informações confirmadas do perfil.",
  "ATS_REVIEW_REQUIRED": "O currículo precisa passar na revisão ATS (ou ter uma justificativa de exceção) antes da aprovação.",
  "ATS_BASE_RESUME_MISMATCH": "O perfil confirmado veio de outro currículo-base. Selecione o PDF de origem do perfil em Currículos.",
  "ATS_CONFIRMED_FACTS_REQUIRED": "O perfil confirmado não tem informações para o currículo. Revise o perfil antes de gerar.",
  "ATS_FACT_UNCONFIRMED": "Uma informação do perfil deixou de estar confirmada. Atualize a página e gere de novo.",
  "ILLEGAL_TRANSITION": "Essa mudança de etapa não é permitida.",
  "INVALID_COMMAND": "Comando de etapa inválido.",
  "PRECONDITION_FAILED": "Faltam informações para essa mudança de etapa.",
  "VERSION_CONFLICT": "O registro foi alterado em outra tela. Atualize e tente de novo.",
  "agent.allowed_domains.invalid": "Lista de domínios permitidos inválida.",
  "agent.allowed_domains.required": "Informe ao menos um domínio permitido para o agente.",
  "agent.browser_scope.required": "Este papel de agente exige o escopo de navegador.",
  "agent.concurrency.invalid": "Concorrência do agente inválida.",
  "agent.create_scope.required": "Para registrar vagas o agente precisa do escopo jobs.create.",
  "agent.description.too_long": "A descrição do agente está longa demais.",
  "agent.disabled": "O agente está pausado.",
  "agent.edit_scope.required": "Para enriquecer vagas o agente precisa do escopo jobs.enrich.",
  "agent.fallback_policy.invalid": "Política de fallback do agente inválida.",
  "agent.has_history.disable_instead": "Este agente já tem histórico: pause-o em vez de excluir.",
  "agent.max_cost.invalid": "Custo máximo por execução inválido.",
  "agent.max_input_tokens.invalid": "Limite de tokens de entrada inválido.",
  "agent.max_output_tokens.invalid": "Limite de tokens de saída inválido.",
  "agent.model_id.invalid": "Modelo do agente inválido.",
  "agent.name.invalid": "Informe um nome válido para o agente.",
  "agent.prompt.too_long": "O prompt do agente está longo demais.",
  "agent.reasoning_effort.invalid": "Nível de raciocínio do agente inválido.",
  "agent.role_type.invalid": "Papel do agente inválido.",
  "agent.timeout.invalid": "Tempo limite do agente inválido.",
  "agent.tool_scopes.role_forbidden": "Um dos escopos não é permitido para este papel de agente.",
  "agent.version.not_found": "Versão do agente não encontrada. Atualize a página.",
  "application.authorization.race": "A autorização mudou ao mesmo tempo em outra tela. Atualize e tente de novo.",
  "connector.company.name_invalid": "Informe um nome válido para a empresa.",
  "connector.company.not_found": "Empresa não encontrada. Atualize a página.",
  "connector.company.query_invalid": "Consulta da empresa inválida.",
  "connector.company.slug_invalid": "Identificador da empresa no ATS inválido.",
  "connector.cost_per_request.invalid": "Custo por requisição inválido.",
  "connector.enrichment.status.invalid": "Estado do item de enriquecimento inválido.",
  "connector.max_cost.invalid": "Custo máximo da coleta inválido.",
  "connector.unknown": "Conector desconhecido.",
  "feedback.confirmation.partial": "Confirme que a rejeição vale só para esta vaga.",
  "feedback.confirmation.total": "Confirme que a rejeição vale para vagas parecidas.",
  "feedback.detail_key.incompatible": "O detalhe escolhido não combina com o motivo.",
  "feedback.explanation.length": "A justificativa precisa ter entre 10 e 500 caracteres.",
  "feedback.mode.invalid": "Modo de rejeição inválido.",
  "feedback.reason_code.invalid": "Motivo de rejeição inválido.",
  "field_conflict.evidence_not_found": "A fonte escolhida para esse campo não existe mais. Atualize a página.",
  "field_conflict.not_found": "Esse conflito de campo já foi resolvido. Atualize a página.",
  "human_question.not_found": "Pergunta não encontrada. Atualize a página.",
  "human_question.not_pending": "A pergunta não está mais aguardando resposta.",
  "job.field.not_editable": "Este campo da vaga não pode ser editado por aqui.",
  "job.opening_status.invalid": "Situação da vaga inválida.",
  "job.persist.failed": "Não foi possível gravar a vaga. Tente novamente.",
  "job.salary_period.invalid": "Período do salário inválido.",
  "job.source_url.required": "Informe a URL de origem da vaga.",
  "job.already_exists": "Esta vaga já está no radar. Edite a vaga existente.",
  "possible_duplicate.not_found": "Essa duplicidade já foi resolvida.",
  "possible_duplicate.status.invalid": "Escolha mesclar ou manter as vagas separadas.",
  "preference_rule.not_found": "Regra de preferência não encontrada. Atualize a página.",
  "preference_rule.state.invalid": "Estado da regra de preferência inválido.",
  "resume.content.empty": "O currículo está vazio. Escreva o conteúdo antes de revisar ou aprovar.",
  "resume.fact.action.invalid": "Ação inválida para o fato do currículo.",
  "resume.facts.span_invalid": "Trecho do fato fora do conteúdo do currículo.",
  "resume.review.verdict.invalid": "Resultado da revisão do currículo inválido.",
  "resume.status.invalid": "Estado do currículo inválido.",
  "round.source.status.invalid": "Estado da fonte na rodada inválido.",
  "settings.automation.ats_allowlist.invalid": "Lista de ATS inválida: use um domínio por linha (ex.: greenhouse.io).",
  "settings.automation.daily_limit.invalid": "O limite diário precisa ser um número inteiro de 0 a 100.",
  "settings.automation.enabled.invalid": "Informe se a automação fica ligada ou desligada.",
  "settings.automation.per_ats_limit.invalid": "O limite por ATS precisa ser um número inteiro de 0 a 100.",
  "source.browser_profile.required": "Informe o id do perfil do navegador.",
  "source.domain.invalid": "Domínio inválido.",
  "source.identity.invalid": "Identificador da fonte inválido.",
  "source.in_use.disable_instead": "Esta fonte está em uso: desative-a em vez de excluir.",
  "source.not_found": "Fonte não encontrada. Atualize a página.",
  "source.readiness.invalid": "Estado de prontidão da fonte inválido.",
  "source.secret_ref.invalid": "Referência de segredo inválida. Use o cofre do Hermes e informe só o id do perfil do navegador.",
  "source.secret_ref.required": "Esse tipo de acesso exige uma referência de segredo.",
  "source.type.invalid": "Tipo de fonte inválido.",
  "workflow.status_requires_transition_command": "A etapa da vaga muda só pelos botões de etapa, não pela edição.",
};

const DEFAULT_REJECTION_MESSAGE = "A operação foi recusada pelas regras do Radar.";

/** Mensagem pt-BR para um código (com ou sem sufixo `:detalhe`). */
export function messageForCode(code: string, fallback = DEFAULT_REJECTION_MESSAGE): string {
  const base = code.split(":")[0] ?? code;
  return ERROR_MESSAGES[code] ?? ERROR_MESSAGES[base] ?? fallback;
}

/** Mensagem segura de um `DomainError`: dicionário primeiro; senão o texto pt-BR do próprio erro. */
export function userMessage(error: DomainError): string {
  return messageForCode(error.code, error.message && error.message !== error.code ? error.message : DEFAULT_REJECTION_MESSAGE);
}

/**
 * Erro de domínio da borda (HTTP/MCP): a própria classe e as subclasses (`DomainValidationError`,
 * `WorkflowError`). Não há mais conversão por texto: `Error` puro é sempre erro interno (null → 500).
 */
export function toDomainError(error: unknown): DomainError | null {
  return error instanceof DomainError ? error : null;
}
