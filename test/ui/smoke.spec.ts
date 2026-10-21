/**
 * Smoke de UI: login pelo /auth, visita de todas as páginas do menu, sem erro de console
 * e sem violação `serious`/`critical` do axe (fora da allowlist explícita abaixo).
 * Existe antes da migração das telas para Preact: a mesma suíte vale para telas legadas
 * (string + innerHTML) e migradas, garantindo que a troca não muda o que o usuário vê.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { type Browser, type Page, expect, test } from "@playwright/test";

const token = process.env.RADAR_UI_SMOKE_TOKEN ?? "";

/** Mesma ordem e rótulos de `pageMeta` em public/app.ts. */
const pages = [
  { page: "overview", hash: "painel", label: "Visão geral" },
  { page: "board", hash: "quadro", label: "Quadro" },
  { page: "jobs", hash: "vagas", label: "Vagas", seeded: "Pessoa desenvolvedora TypeScript" },
  { page: "applications", hash: "candidaturas", label: "Candidaturas", seeded: "Analista de candidaturas smoke" },
  { page: "resumes", hash: "curriculos", label: "Currículos", seeded: "Currículo smoke" },
  { page: "companies", hash: "empresas", label: "Empresas", seeded: "Outra Empresa" },
  { page: "analytics", hash: "analises", label: "Análises" },
  { page: "operations", hash: "saude", label: "Saúde das buscas" },
  { page: "agents", hash: "agentes", label: "Agentes" },
  { page: "settings", hash: "configuracoes", label: "Configurações" }
] as { page: string; hash: string; label: string; seeded?: string }[];

/**
 * Violações já existentes antes do smoke, aceitas por regra + página. Cada item precisa de
 * um TODO com o motivo; a suíte falha se uma entrada deixar de ser necessária (allowlist
 * não pode apodrecer) ou se aparecer qualquer violação nova.
 * Formato: { rule: id da regra do axe, page: chave de pageMeta, todo: motivo }.
 */
const axeAllowlist: { rule: string; page: string; todo: string }[] = [];

const BLOCKING_IMPACTS = new Set(["serious", "critical"]);

async function login(page: Page) {
  const response = await page.goto(`auth?token=${encodeURIComponent(token)}`);
  expect(response?.ok(), "login pelo /auth deve redirecionar para o painel").toBeTruthy();
  await expect(page.locator("#page-heading")).toBeVisible();
}

/** Coleta erros de console e exceções não tratadas da página. */
function watchConsole(page: Page) {
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

/** Dados mínimos para as páginas não ficarem vazias: duas vagas, interesse, currículo e candidatura. */
async function seed(browser: Browser) {
  const context = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  const page = await context.newPage();
  await login(page);
  const api = async (method: string, path: string, data?: unknown) => {
    const response = await context.request.fetch(path, { method, data, headers: data === undefined ? {} : { "content-type": "application/json" } });
    expect(response.ok(), `${method} ${path}: ${response.status()} ${await response.text()}`).toBeTruthy();
    return response.json();
  };
  // O Playwright reinicia o worker depois de uma falha e roda o beforeAll de novo: semeia uma vez só.
  const bootstrap = await api("GET", "api/bootstrap");
  if (bootstrap.jobs.some((item: { source_url: string }) => item.source_url.includes("/ui-smoke/"))) { await context.close(); return; }
  const job = await api("POST", "api/jobs", {
    title: "Pessoa desenvolvedora TypeScript", company: "Empresa Exemplo", location: "São Paulo, SP", work_model: "remote",
    source: "fixture", source_url: "https://jobs.example.test/ui-smoke/1", application_url: "https://jobs.example.test/ui-smoke/1/apply",
    salary_min: 9000, salary_max: 12000, currency: "BRL", salary_period: "month", description: "Vaga semeada pelo smoke de UI."
  });
  await api("POST", "api/jobs", {
    title: "Engenharia de dados", company: "Outra Empresa", location: "Recife, PE", source: "fixture",
    source_url: "https://jobs.example.test/ui-smoke/2", application_url: "https://jobs.example.test/ui-smoke/2/apply"
  });
  await api("POST", `api/jobs/${job.id}/decision`, { decision: "interested", confirmation: "TENHO INTERESSE" });
  await api("POST", "api/resumes", { job_id: job.id, title: "Currículo smoke", content: "RESUMO\nExperiência confirmada com TypeScript." });
  // Terceira vaga com currículo aprovado (APROVO) e candidatura manual, para a tabela de Candidaturas.
  const applied = await api("POST", "api/jobs", {
    title: "Analista de candidaturas smoke", company: "Empresa Candidatura", location: "Curitiba, PR", source: "fixture",
    source_url: "https://jobs.example.test/ui-smoke/3", application_url: "https://jobs.example.test/ui-smoke/3/apply"
  });
  await api("POST", `api/jobs/${applied.id}/decision`, { decision: "interested", confirmation: "TENHO INTERESSE" });
  const resume = await api("POST", "api/resumes", { job_id: applied.id, title: "Currículo candidatura smoke", content: "RESUMO\nAnálise de processos." });
  await api("POST", `api/resumes/${resume.id}/approve`, { confirmation: "APROVO", override_reason: "Currículo semeado pelo smoke de UI." });
  await api("POST", "api/applications", { job_id: applied.id, resume_id: resume.id, automation_mode: "manual", current_step: "Etapa smoke" });
  await context.close();
}

test.describe("smoke de UI", () => {
  test.beforeAll(async ({ browser }) => { await seed(browser); });

  for (const { page: key, hash, label, seeded } of pages) {
    test(`página ${label} (#/${hash}) renderiza, sem erro de console e sem violação séria do axe`, async ({ page }) => {
      const errors = watchConsole(page);
      await login(page);
      await page.goto(`#/${hash}`);
      await expect(page.locator("#page-heading")).toHaveText(label);
      await expect(page).toHaveTitle(`${label} · Radar de Vagas`);
      await expect(page.locator(`.sidebar [data-page="${key}"]`)).toHaveAttribute("aria-current", "page");
      await expect(page.locator("#view .loading-state")).toHaveCount(0);
      if (seeded) await expect(page.locator("#view")).toContainText(seeded);

      const results = await new AxeBuilder({ page }).analyze();
      const blocking = results.violations.filter((violation) => BLOCKING_IMPACTS.has(violation.impact ?? ""));
      const allowed = axeAllowlist.filter((entry) => entry.page === key).map((entry) => entry.rule);
      const unexpected = blocking.filter((violation) => !allowed.includes(violation.id));
      expect(unexpected.map((violation) => ({ rule: violation.id, impact: violation.impact, help: violation.help, nodes: violation.nodes.slice(0, 3).map((node) => node.target.join(" ")) })), "violações sérias/críticas do axe").toEqual([]);
      const stale = allowed.filter((rule) => !blocking.some((violation) => violation.id === rule));
      expect(stale, "entradas da allowlist do axe que não são mais necessárias (remova-as)").toEqual([]);

      expect(errors, "erros de console").toEqual([]);
    });
  }

  test("navegação pelo menu lateral troca de página e mantém o foco no título", async ({ page }) => {
    const errors = watchConsole(page);
    await login(page);
    // Começa em Visão geral (#/ vazio); cada clique troca de página e o foco vai para o título.
    for (const { page: key, hash, label } of pages.slice(1)) {
      await page.locator(`.sidebar [data-page="${key}"]`).click();
      await expect(page.locator("#page-heading")).toHaveText(label);
      await expect(page).toHaveURL(new RegExp(`#/${hash}`));
      await expect(page.locator("#page-heading")).toBeFocused();
    }
    // Volta para uma página legada depois de outra (garante desmontagem limpa entre os dois modos).
    await page.locator('.sidebar [data-page="agents"]').click();
    await page.locator('.sidebar [data-page="overview"]').click();
    await expect(page.locator("#page-heading")).toHaveText("Visão geral");
    await expect(page.locator("#page-heading")).toBeFocused();
    expect(errors, "erros de console").toEqual([]);
  });

  test("Agentes: cartões, Editar e Novo agente abrem o modal", async ({ page }) => {
    const errors = watchConsole(page);
    await login(page);
    await page.goto("#/agentes");
    const cards = page.locator("#view .agent-card");
    expect(await cards.count(), "agentes padrão devem aparecer").toBeGreaterThan(0);
    await expect(page.locator(".page-heading .subtitle")).toContainText("agentes ativos");
    await cards.first().getByRole("button", { name: "Editar" }).click();
    await expect(page.locator("#modal-root .modal")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#modal-root .modal")).toBeHidden();
    await page.getByRole("button", { name: "Novo agente" }).click();
    await expect(page.locator("#modal-root .modal")).toBeVisible();
    await page.keyboard.press("Escape");
    await cards.first().getByRole("button", { name: "Versões" }).click();
    await expect(page.locator("#modal-root .modal")).toBeVisible();
    await page.keyboard.press("Escape");
    // Recarregar os dados re-renderiza a página no lugar (diff do Preact; innerHTML no legado).
    const total = await cards.count();
    await page.locator("#refresh-button").click();
    await expect(page.locator("#sync-label")).toContainText("Atualizado");
    await expect(cards).toHaveCount(total);
    expect(errors, "erros de console").toEqual([]);
  });

  test("Candidaturas: tabela com estado, modo e etapa; Abrir mostra o detalhe da vaga", async ({ page }) => {
    const errors = watchConsole(page);
    await login(page);
    await page.goto("#/candidaturas");
    const row = page.locator("#view table.data-table tbody tr", { hasText: "Analista de candidaturas smoke" });
    await expect(row).toHaveCount(1);
    await expect(row.locator('[data-label="Estado"]')).toHaveText("Na fila");
    await expect(row.locator('[data-label="Modo"]')).toHaveText("Manual");
    await expect(row.locator('[data-label="Autorização"]')).toHaveText("—");
    await expect(row.locator('[data-label="Etapa"]')).toHaveText("Etapa smoke");
    await row.getByRole("button", { name: "Abrir Analista de candidaturas smoke" }).click();
    await expect(page.locator("#modal-root .modal")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#modal-root .modal")).toBeHidden();
    expect(errors, "erros de console").toEqual([]);
  });

  test("Saúde das buscas: painel de automação com limites e fila de confirmação final", async ({ page }) => {
    const errors = watchConsole(page);
    await login(page);
    await page.goto("#/saude");
    const panel = page.locator('#view section[aria-labelledby="automation-title"]');
    await expect(panel.getByRole("heading", { name: "Automação de candidaturas" })).toBeVisible();
    await expect(panel.getByText("Kill-switch")).toBeVisible();
    await expect(panel.getByText("Envios de hoje")).toBeVisible();
    const daily = panel.getByLabel("Limite diário (todos os ATS)");
    await expect(daily).toBeVisible();
    await expect(daily).toHaveValue(/^\d+$/u);
    await expect(panel.getByLabel("Limite diário por ATS")).toBeVisible();
    await expect(panel.getByLabel("ATS permitidos (um domínio por linha)")).not.toHaveValue("");
    await expect(panel.getByRole("button", { name: "Salvar limites e ATS" })).toBeVisible();
    const queue = page.locator('#view section[aria-labelledby="final-confirmation-title"]');
    await expect(queue.getByRole("heading", { name: "Aguardando confirmação final" })).toBeVisible();
    await expect(queue).toContainText("Nada aguardando");
    await expect(page.locator("#view")).toContainText("Possíveis duplicatas");
    await expect(page.locator("#view")).toContainText("Perguntas para você");
    expect(errors, "erros de console").toEqual([]);
  });

  test("Saúde das buscas: pausar o kill-switch pede confirmação e chama PUT /api/settings/automation", async ({ page }) => {
    const errors = watchConsole(page);
    await login(page);
    await page.goto("#/saude");
    const panel = page.locator('#view section[aria-labelledby="automation-title"]');
    const pause = panel.getByRole("button", { name: "Pausar automação" });
    await expect(pause).toBeVisible();
    const dialog = page.locator("#dialog-root form.dialog");

    // Cancelar a confirmação não chama a API nem muda o estado.
    const puts: string[] = [];
    page.on("request", (request) => { if (request.method() === "PUT" && request.url().endsWith("/api/settings/automation")) puts.push(request.postData() ?? ""); });
    await pause.click();
    await expect(dialog.getByRole("heading", { name: "Pausar a candidatura automática?" })).toBeVisible();
    await dialog.getByRole("button", { name: "Cancelar" }).click();
    await expect(dialog).toHaveCount(0);
    expect(puts, "cancelar não pode chamar a API").toEqual([]);
    await expect(pause).toBeVisible();

    // Confirmar pausa: PUT { enabled: false } e o botão vira "Religar automação".
    await pause.click();
    await expect(dialog.getByRole("heading", { name: "Pausar a candidatura automática?" })).toBeVisible();
    const paused = page.waitForResponse((response) => response.request().method() === "PUT" && response.url().endsWith("/api/settings/automation"));
    await dialog.getByRole("button", { name: "Pausar", exact: true }).click();
    expect((await paused).ok()).toBeTruthy();
    expect(JSON.parse(puts.at(-1) ?? "{}")).toEqual({ enabled: false });
    await expect(panel.getByText("Pausada (kill-switch)")).toBeVisible();

    // Restaura: religar não pede confirmação e manda { enabled: true }.
    const resume = panel.getByRole("button", { name: "Religar automação" });
    const resumed = page.waitForResponse((response) => response.request().method() === "PUT" && response.url().endsWith("/api/settings/automation"));
    await resume.click();
    expect((await resumed).ok()).toBeTruthy();
    expect(JSON.parse(puts.at(-1) ?? "{}")).toEqual({ enabled: true });
    await expect(pause).toBeVisible();
    expect(errors, "erros de console").toEqual([]);
  });

  test("Saúde das buscas: confirmação final mostra a captura e só envia com ENVIAR", async ({ page }) => {
    const errors = watchConsole(page);
    // Fila simulada no bootstrap (o fluxo real depende do executor): nada sai para a rede.
    const applicationId = "app-ui-smoke-final";
    await page.route("**/api/bootstrap", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      const job = body.jobs[0];
      body.automation.final_confirmations = [{
        application_id: applicationId, job_id: job.id, requested_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        claimed_by: "executor-smoke", evidence_id: "ev-smoke", observed_url: "https://jobs.example.test/ui-smoke/1/apply",
        fields_summary: [{ label: "Nome", value: "Pessoa Smoke" }, { label: "E-mail", value: "" }], created_at: new Date().toISOString()
      }];
      await route.fulfill({ response, json: body });
    });
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
    await page.route(`**/api/applications/${applicationId}/evidence/ev-smoke`, (route) => route.fulfill({ contentType: "image/png", body: png }));
    const confirms: string[] = [];
    await page.route(`**/api/applications/${applicationId}/confirm-final`, (route) => {
      confirms.push(route.request().postData() ?? "");
      return route.fulfill({ json: { ok: true } });
    });
    await login(page);
    await page.goto("#/saude");
    const queue = page.locator('#view section[aria-labelledby="final-confirmation-title"]');
    const card = queue.locator("article.final-confirmation");
    await expect(card).toHaveCount(1);
    await expect(card.locator("dl.final-fields")).toContainText("Pessoa Smoke");
    await expect(card.locator("dl.final-fields dd").nth(1)).toHaveText("—");
    const shot = card.locator("img.final-shot");
    await expect(shot).toHaveAttribute("src", `/api/applications/${applicationId}/evidence/ev-smoke`);
    await expect(shot).toHaveAttribute("alt", /^Captura da tela antes do envio: /u);
    const axe = await new AxeBuilder({ page }).include("#view").analyze();
    expect(axe.violations.filter((violation) => BLOCKING_IMPACTS.has(violation.impact ?? "")).map((violation) => violation.id), "axe com a fila preenchida").toEqual([]);

    const dialog = page.locator("#dialog-root form.dialog");
    await card.getByRole("button", { name: "Enviar agora" }).click();
    await expect(dialog.getByRole("heading", { name: "Enviar candidatura agora?" })).toBeVisible();
    // Texto errado não envia: o formulário exige ENVIAR em maiúsculas.
    await dialog.getByLabel("Digite ENVIAR para confirmar").fill("enviar");
    await dialog.getByRole("button", { name: "Enviar agora" }).click();
    await expect(dialog).toBeVisible();
    expect(confirms, "sem ENVIAR não pode chamar a API").toEqual([]);
    await dialog.getByRole("button", { name: "Cancelar" }).click();
    await expect(dialog).toHaveCount(0);
    expect(confirms).toEqual([]);

    await card.getByRole("button", { name: "Enviar agora" }).click();
    await dialog.getByLabel("Digite ENVIAR para confirmar").fill("ENVIAR");
    await dialog.getByRole("button", { name: "Enviar agora" }).click();
    await expect.poll(() => confirms.length).toBe(1);
    expect(JSON.parse(confirms[0]!)).toEqual({ confirmation: "ENVIAR" });
    expect(errors, "erros de console").toEqual([]);
  });
});
