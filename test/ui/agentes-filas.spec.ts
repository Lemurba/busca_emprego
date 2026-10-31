/**
 * UI da etapa "Agentes e filas" (auditoria 2026-10-30 §2 itens 3–5, §4.3 F24): revisão antes de
 * publicar uma versão de agente, fila de enriquecimento, resposta pelo painel a pergunta com
 * entrega falha e desfazer a decisão sobre uma possível duplicata.
 *
 * Independente do seed do smoke: filas e perguntas são simuladas por `page.route` (nada é
 * gravado no banco), e o único dado real alterado (um rascunho de agente) é descartado pela
 * própria UI no fim do teste.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { type Page, type Route, expect, test } from "@playwright/test";

const token = process.env.RADAR_UI_SMOKE_TOKEN ?? "";
const BLOCKING_IMPACTS = new Set(["serious", "critical"]);

async function login(page: Page) {
  const response = await page.goto(`auth?token=${encodeURIComponent(token)}`);
  expect(response?.ok(), "login pelo /auth deve redirecionar para o painel").toBeTruthy();
  await expect(page.locator("#page-heading")).toBeVisible();
}

function watchConsole(page: Page) {
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

/** Violações sérias/críticas; `include` limita a análise (avisos em animação dão falso contraste). */
async function seriousAxe(page: Page, include?: string) {
  const builder = new AxeBuilder({ page });
  const results = await (include ? builder.include(include) : builder).analyze();
  return results.violations.filter((violation) => BLOCKING_IMPACTS.has(violation.impact ?? "")).map((violation) => ({ rule: violation.id, nodes: violation.nodes.slice(0, 3).map((node) => node.target.join(" ")) }));
}

/** Acrescenta campos ao bootstrap real (sem tocar no banco). */
async function patchBootstrap(page: Page, patch: (body: Record<string, any>) => void) {
  await page.route("**/api/bootstrap", async (route: Route) => {
    const response = await route.fetch();
    const body = await response.json();
    patch(body);
    await route.fulfill({ response, json: body });
  });
}

test.describe("agentes e filas", () => {
  test("Publicar agente mostra o diff, a origem e exige revisão da proposta do coordenador", async ({ page }) => {
    const errors = watchConsole(page);
    await login(page);
    const agents = await (await page.request.get("api/agents")).json() as Array<{ id: string; name: string; prompt: string }>;
    const agent = agents[0]!;
    const draft = await (await page.request.fetch(`api/agents/${agent.id}`, { method: "PATCH", data: { prompt: `${agent.prompt}\nLinha nova revisada no smoke.`, timeout_seconds: 300 } })).json();
    expect(draft.draft_version_id).toBeTruthy();

    await page.goto("#/agentes");
    // O rascunho foi criado depois do login: recarrega os dados do painel.
    await page.locator("#refresh-button").click();
    await expect(page.locator("#sync-label")).toContainText("Atualizado");
    const card = page.locator("#view .agent-card").filter({ has: page.getByRole("heading", { name: agent.name, exact: true }) });
    await card.getByRole("button", { name: "Publicar" }).click();
    const modal = page.locator("#modal-root .modal");
    await expect(modal.getByRole("heading", { name: `Publicar ${agent.name}?` })).toBeVisible();
    await expect(modal.locator(".publish-origin")).toContainText("Editada por você");
    await expect(modal.locator(".diff-table")).toContainText("Tempo limite (segundos)");
    await expect(modal.locator(".diff-table")).toContainText("300");
    await expect(modal.locator(".prompt-diff .diff-line.add")).toContainText("Linha nova revisada no smoke.");
    await expect(modal.getByRole("button", { name: /^Publicar versão/u })).toBeEnabled();
    expect(await seriousAxe(page), "axe com a revisão aberta").toEqual([]);
    await modal.getByRole("button", { name: "Cancelar" }).click();
    await expect(modal).toBeHidden();

    // Proposta do coordenador (origem simulada no diff): aviso, justificativa e publicar só depois de marcar a revisão.
    await page.route(`**/api/agents/${agent.id}/versions/*/diff`, async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({ response, json: { ...body, origin: "coordinator", created_by: "hermes-memory", proposal_reason: "Feedback confirmado sobre vagas antigas." } });
    });
    const publishes: string[] = [];
    await page.route(`**/api/agents/${agent.id}/publish`, (route) => { publishes.push(route.request().postData() ?? ""); return route.fulfill({ json: { id: agent.id } }); });
    await card.getByRole("button", { name: "Publicar" }).click();
    await expect(modal.locator(".publish-origin")).toContainText("Proposta do coordenador");
    await expect(modal.locator(".notice.warning")).toContainText("Feedback confirmado sobre vagas antigas.");
    const publish = modal.getByRole("button", { name: /^Publicar versão/u });
    await expect(publish).toBeDisabled();
    await modal.getByLabel(/Revisei as mudanças/u).check();
    await expect(publish).toBeEnabled();
    await publish.click();
    await expect.poll(() => publishes.length).toBe(1);
    const sent = JSON.parse(publishes[0]!);
    expect(sent.version_id).toBe(draft.draft_version_id);
    expect(sent.checksum).toMatch(/^[0-9a-f]{64}$/u);
    await page.unrouteAll({ behavior: "ignoreErrors" });

    // Descartar o rascunho pela revisão (devolve o agente ao estado publicado).
    await card.getByRole("button", { name: "Publicar" }).click();
    await modal.getByRole("button", { name: "Descartar rascunho" }).click();
    await page.getByRole("alertdialog", { name: "Descartar este rascunho?" }).getByRole("button", { name: "Descartar" }).click();
    await expect(page.locator("#toast-root .toast", { hasText: "Rascunho descartado." })).toHaveCount(1);
    await expect(card.getByRole("button", { name: "Publicar" })).toHaveCount(0);
    expect(errors, "erros de console").toEqual([]);
  });

  test("Fila de enriquecimento lista itens e fecha pelo painel", async ({ page }) => {
    const errors = watchConsole(page);
    const item = { id: "fila-1", source_id: "greenhouse", job_url: "https://jobs.example.test/fila/1", title: "Vaga sem descrição", company: "Empresa Fila", reason: "connector.enrichment.no_structured_data", created_at: new Date().toISOString(), job_id: null, status: "pending" };
    let pending = [item];
    const resolutions: string[] = [];
    await page.route("**/api/connectors/enrichment-queue", (route) => route.fulfill({ json: pending }));
    await page.route("**/api/connectors/enrichment-queue/fila-1", (route) => {
      resolutions.push(route.request().postData() ?? "");
      pending = [];
      return route.fulfill({ json: { id: "fila-1", status: "done" } });
    });
    await login(page);
    await page.goto("#/agentes");
    const panel = page.locator("#view [data-enrichment-queue]");
    await expect(panel.getByRole("heading", { name: "Fila de enriquecimento (1)" })).toBeVisible();
    await expect(panel).toContainText("Empresa Fila · greenhouse · A página não tem dados estruturados");
    await expect(panel.getByRole("link", { name: /Abrir anúncio/u })).toHaveAttribute("href", item.job_url);
    expect(await seriousAxe(page), "axe com a fila preenchida").toEqual([]);
    await panel.getByRole("button", { name: "Resolvido" }).click();
    await expect.poll(() => resolutions.length).toBe(1);
    expect(JSON.parse(resolutions[0]!)).toEqual({ status: "done" });
    await expect(panel).toContainText("Nenhuma vaga esperando enriquecimento.");
    await page.unrouteAll({ behavior: "ignoreErrors" });
    expect(errors, "erros de console").toEqual([]);
  });

  test("Pergunta com entrega falha é respondida pelo painel", async ({ page }) => {
    const errors = watchConsole(page);
    const question = {
      id: "pergunta-smoke", application_id: "candidatura-smoke", job_id: "vaga-smoke", question: "Aceita viagens a trabalho?", status: "delivery_failed",
      required: true, choices: ["Sim", "Não"], uncertainty_reason: "Perfil não informa", step: "formulário", sanitized_delivery_error: "telegram indisponível", asked_at: new Date().toISOString()
    };
    await patchBootstrap(page, (body) => { body.humanQuestions = [question]; });
    const answers: string[] = [];
    await page.route("**/api/human-questions/pergunta-smoke/respond", (route) => { answers.push(route.request().postData() ?? ""); return route.fulfill({ json: { ...question, status: "answered" } }); });
    await login(page);
    await page.goto("#/saude");
    const item = page.locator("#view .ops-item", { hasText: "Aceita viagens a trabalho?" });
    await expect(item).toContainText("Não chegou ao Telegram");
    await item.getByRole("button", { name: "Responder aqui" }).click();
    const dialog = page.getByRole("alertdialog", { name: "Responder pelo painel" });
    await expect(dialog).toContainText("A mensagem não chegou ao Telegram (telegram indisponível)");
    // Pergunta obrigatória não oferece "Pular".
    await expect(dialog.getByRole("radio", { name: /Pular/u })).toHaveCount(0);
    expect(await seriousAxe(page), "axe com o diálogo aberto").toEqual([]);
    await dialog.getByRole("button", { name: "Enviar resposta" }).click();
    await expect(dialog.locator(".dialog-error")).toHaveText("Escreva a resposta ou escolha outra opção.");
    expect(answers).toEqual([]);
    await dialog.getByLabel("Resposta", { exact: true }).fill("Sim, até 20% do tempo");
    await dialog.getByRole("button", { name: "Enviar resposta" }).click();
    await expect.poll(() => answers.length).toBe(1);
    expect(JSON.parse(answers[0]!)).toEqual({ action: "answer", answer: "Sim, até 20% do tempo" });
    await expect(page.locator("#toast-root .toast", { hasText: "Resposta registrada" })).toHaveCount(1);
    await page.unrouteAll({ behavior: "ignoreErrors" });
    expect(errors, "erros de console").toEqual([]);
  });

  test("Mesclar duplicata pede confirmação e pode ser desfeito", async ({ page }) => {
    const errors = watchConsole(page);
    const now = new Date().toISOString();
    const pendingDuplicate = { id: "dup-smoke", job_id: "vaga-a", candidate_job_id: "vaga-b", similarity: 0.92, status: "pending", created_at: now };
    const decided = { ...pendingDuplicate, id: "dup-antiga", status: "merged", reviewed_at: now, undo_until: new Date(Date.now() + 86_400_000).toISOString() };
    await patchBootstrap(page, (body) => { body.possibleDuplicates = [pendingDuplicate]; body.recentDuplicateDecisions = [decided]; });
    const calls: string[] = [];
    await page.route("**/api/possible-duplicates/*/*", (route) => {
      calls.push(`${new URL(route.request().url()).pathname.split("/").slice(-2).join("/")} ${route.request().postData() ?? ""}`);
      return route.fulfill({ json: { ok: true } });
    });
    await login(page);
    await page.goto("#/saude");
    await expect(page.locator("#view")).toContainText("Decididas recentemente");
    const pending = page.locator("#view .ops-item", { hasText: "92% de semelhança" });
    await pending.getByRole("button", { name: "Mesclar" }).click();
    const dialog = page.getByRole("alertdialog", { name: "Mesclar as duas vagas?" });
    await expect(dialog).toContainText("você pode desfazer a decisão por 24 horas");
    await dialog.getByRole("button", { name: "Cancelar" }).click();
    expect(calls, "cancelar não chama a API").toEqual([]);
    await pending.getByRole("button", { name: "Mesclar" }).click();
    await dialog.getByRole("button", { name: "Mesclar" }).click();
    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0]).toBe('dup-smoke/resolve {"status":"merged"}');
    // Desfazer pelo aviso logo depois de mesclar.
    await page.locator("#toast-root .toast", { hasText: "Vagas mescladas." }).getByRole("button", { name: "Desfazer" }).click();
    await expect.poll(() => calls.length).toBe(2);
    expect(calls[1]).toBe("dup-smoke/undo {}");
    // E pela lista de decididas recentemente.
    await page.locator("#view .ops-item", { hasText: "desfazer até" }).getByRole("button", { name: "Desfazer" }).click();
    await expect.poll(() => calls.length).toBe(3);
    expect(calls[2]).toBe("dup-antiga/undo {}");
    expect(await seriousAxe(page, "#view"), "axe com duplicatas e decisões recentes").toEqual([]);
    await page.unrouteAll({ behavior: "ignoreErrors" });
    expect(errors, "erros de console").toEqual([]);
  });
});
