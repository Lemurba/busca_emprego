/**
 * Contrato dos códigos de erro (#29) e validação de domínio → 422 (#17).
 * As bordas HTTP e MCP decidem status e mensagem só pelo `code` do erro.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "radar-error-contract-"));
process.env.RADAR_DB_PATH = join(directory, "errors.sqlite");
delete process.env.RADAR_RUN_LEGACY_ANONYMIZATION;
const { DomainError, ERROR_MESSAGES, statusForCode, toDomainError } = await import("../src/errors.ts");
const { DomainValidationError } = await import("../src/domain.ts");
const { WorkflowError } = await import("../src/workflow.ts");
const { errorResponse } = await import("../src/http-security.ts");
const { toolError } = await import("../src/mcp-server.ts");

const mcp = (error) => JSON.parse(toolError(error).content[0].text).error;

try {
  await test("tabela de status por código (contrato estável)", () => {
    const contract = {
      "job.not_found": 404, not_found: 404, "agent.domain.forbidden": 403, AUTOMATION_DISABLED: 403,
      "application.internal_route_required": 403, PDF_DUPLICATE: 409, PDF_TOO_LARGE: 413,
      "workflow.version_conflict": 409, "application.authorization.race": 409, "job.salary.invalid:min": 422,
      "job.archived": 422, "application.url.insecure": 422, "validation.url": 422, VERSION_CONFLICT: 409,
      ILLEGAL_TRANSITION: 409, PRECONDITION_FAILED: 422, "algo.desconhecido": 400,
    };
    for (const [code, status] of Object.entries(contract)) assert.equal(statusForCode(code), status, code);
  });

  await test("DomainError: status explícito vence; sem status usa a tabela", () => {
    assert.equal(new DomainError("job.not_found").status, 404);
    assert.equal(new DomainError("job.not_found", 410).status, 410);
    const response = errorResponse(new DomainError("application.url.insecure"));
    assert.equal(response.status, 422);
    assert.equal(response.body.error, "application.url.insecure");
    assert.equal(response.body.message, ERROR_MESSAGES["application.url.insecure"]);
    assert.equal(response.internal, false);
  });

  await test("subclasses (DomainValidationError, WorkflowError) são DomainError", () => {
    const validation = new DomainValidationError("A URL deve usar HTTPS", "url");
    assert.ok(validation instanceof DomainError);
    assert.equal(validation.code, "validation.url");
    assert.equal(validation.status, 422);
    const workflow = new WorkflowError("VERSION_CONFLICT", 409, "O estado foi alterado por outra operação.", { expected_version: 2 });
    assert.ok(workflow instanceof DomainError);
    assert.equal(workflow.httpStatus, 409);
    assert.equal(toDomainError(workflow), workflow);
  });

  await test("HTTP: DomainValidationError → 422 com campo e mensagem (#17)", () => {
    const response = errorResponse(new DomainValidationError("Destino privado não permitido", "url"));
    assert.equal(response.status, 422);
    assert.equal(response.body.error, "validation.url");
    assert.equal(response.body.message, "Destino privado não permitido");
    assert.deepEqual(response.body.details, { field: "url" });
    assert.equal(response.internal, false);
  });

  await test("MCP: DomainValidationError → 422 com campo e mensagem (#17)", () => {
    const error = mcp(new DomainValidationError("URL não pode conter credenciais", "url"));
    assert.equal(error.code, "validation.url");
    assert.equal(error.status, 422);
    assert.equal(error.message, "URL não pode conter credenciais");
    assert.deepEqual(error.details, { field: "url" });
  });

  await test("mensagem vem do dicionário: mudar o texto não muda o status", () => {
    const a = errorResponse(new DomainError("job.archived", undefined, "texto qualquer"));
    const b = errorResponse(new DomainError("job.archived"));
    assert.equal(a.status, b.status);
    assert.equal(a.body.message, ERROR_MESSAGES["job.archived"]);
    assert.equal(b.body.message, ERROR_MESSAGES["job.archived"]);
  });

  await test("código com sufixo: o detalhe vai para details.reason nas duas bordas", () => {
    const response = errorResponse(new DomainError("job.salary.invalid:min,max"));
    assert.equal(response.status, 422);
    assert.equal(response.body.error, "job.salary.invalid:min,max");
    assert.deepEqual(response.body.details, { reason: "min,max" });
    const tool = mcp(new DomainError("agent.domain.forbidden"));
    assert.equal(tool.code, "agent.domain.forbidden");
    assert.equal(tool.status, 403);
  });

  await test("#29: Error puro nunca é lido pelo texto — código ou frase pt-BR viram 500 interno", () => {
    for (const message of ["job.salary.invalid:min", "Vaga não encontrada.", "Confirme digitando AUTORIZO para esta vaga."]) {
      const response = errorResponse(new Error(message));
      assert.equal(response.status, 500, message);
      assert.equal(response.body.error, "internal_error");
      assert.equal(response.internal, true);
      assert.ok(!JSON.stringify(response.body).includes(message), "o texto interno não vaza");
      const tool = mcp(new Error(message));
      assert.equal(tool.code, "internal_error");
      assert.equal(tool.status, 500);
    }
    assert.equal(toDomainError(new Error("job.not_found")), null);
  });

  await test("#29: portões humanos têm código estável e mensagem do dicionário", () => {
    const response = errorResponse(new DomainError("application.authorization.confirmation_required", 400));
    assert.equal(response.status, 400);
    assert.equal(response.body.error, "application.authorization.confirmation_required");
    assert.equal(response.body.message, ERROR_MESSAGES["application.authorization.confirmation_required"]);
    assert.equal(errorResponse(new DomainError("job.not_found")).status, 404);
  });

  await test("WorkflowError mantém status e detalhes nas duas bordas", () => {
    const error = new WorkflowError("ILLEGAL_TRANSITION", 409, "Comando reservado ao fluxo interno.", { command: "x" });
    const response = errorResponse(error);
    assert.equal(response.status, 409);
    assert.equal(response.body.error, "ILLEGAL_TRANSITION");
    assert.deepEqual(response.body.details, { command: "x" });
    const tool = mcp(error);
    assert.equal(tool.code, "ILLEGAL_TRANSITION");
    assert.equal(tool.status, 409);
  });

  await test("erro desconhecido → 500 sem detalhes; MCP loga com request_id", () => {
    const sqlite = Object.assign(new Error("SQLITE_CONSTRAINT: UNIQUE constraint failed: jobs.id"), { code: "ERR_SQLITE_ERROR" });
    for (const error of [sqlite, new TypeError("x is undefined"), "texto solto"]) {
      const response = errorResponse(error);
      assert.equal(response.status, 500);
      assert.equal(response.body.error, "internal_error");
      assert.equal(response.body.details, undefined);
      assert.equal(response.internal, true);
    }
    const logged = [];
    const original = console.error;
    console.error = (line) => logged.push(String(line));
    let tool;
    try { tool = mcp(sqlite); } finally { console.error = original; }
    assert.equal(tool.code, "internal_error");
    assert.equal(tool.status, 500);
    assert.equal(tool.details, undefined);
    assert.doesNotMatch(tool.message, /SQLITE/);
    assert.match(tool.request_id, /^[0-9a-f-]{36}$/u);
    assert.equal(logged.length, 1);
    assert.equal(JSON.parse(logged[0]).request_id, tool.request_id);
  });
} finally {
  rmSync(directory, { recursive: true, force: true });
}

