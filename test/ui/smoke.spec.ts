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
  { page: "applications", hash: "candidaturas", label: "Candidaturas" },
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

  test("Vagas: digitar no filtro mantém o foco e filtra; Detalhes abre o modal da vaga", async ({ page }) => {
    const errors = watchConsole(page);
    await login(page);
    await page.goto("#/vagas");
    const search = page.locator('#view input[data-filter="query"]');
    const rows = page.locator("#view .data-table tbody tr");
    await expect(rows.filter({ hasText: "Pessoa desenvolvedora TypeScript" })).toHaveCount(1);
    await search.click();
    // Tecla a tecla: cada uma re-renderiza a página (diff do Preact) sem recriar o campo.
    await search.pressSequentially("Recife", { delay: 20 });
    await expect(search).toBeFocused();
    await expect(search).toHaveValue("Recife");
    await expect(page.locator("#view .results-count")).toHaveText("1 vaga");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Engenharia de dados");
    await expect(page).toHaveURL(/#\/vagas\?q=Recife/);
    await search.press("End");
    await search.pressSequentially(" sem resultado");
    await expect(search).toBeFocused();
    await expect(page.locator("#view .empty-state")).toContainText("Nenhuma vaga encontrada");
    await search.fill("");
    await expect(rows.filter({ hasText: "Pessoa desenvolvedora TypeScript" })).toHaveCount(1);
    // Select de filtro e ordenação continuam funcionando sem perder o elemento.
    await page.locator('#view select[data-filter="minMatch"]').selectOption("90");
    await expect(page.locator('#view select[data-filter="minMatch"]')).toHaveValue("90");
    await page.locator('#view select[data-filter="minMatch"]').selectOption("0");
    const salarySort = page.locator('#view [data-sort="salary"]');
    await salarySort.click();
    await expect(salarySort).toHaveClass(/active/);
    await expect(salarySort).toBeFocused();
    await expect(page).toHaveURL(/ordem=salary/);
    // Detalhe continua sendo o modal legado (showJobDetail), aberto pela delegação do #view.
    await page.getByRole("button", { name: "Detalhes de Pessoa desenvolvedora TypeScript" }).click();
    await expect(page.locator("#modal-root .modal")).toBeVisible();
    await expect(page.locator("#modal-root .modal")).toContainText("Pessoa desenvolvedora TypeScript");
    await page.keyboard.press("Escape");
    await expect(page.locator("#modal-root .modal")).toBeHidden();
    await page.locator("#view .table-link", { hasText: "Engenharia de dados" }).click();
    await expect(page.locator("#modal-root .modal")).toContainText("Engenharia de dados");
    await page.keyboard.press("Escape");
    expect(errors, "erros de console").toEqual([]);
  });

  test("Currículos: cartão semeado, links de download e formulários de envio/importação", async ({ page }) => {
    const errors = watchConsole(page);
    await login(page);
    const bootstrap = await (await page.request.get("api/bootstrap")).json();
    const resume = bootstrap.resumes.find((item: { title: string }) => item.title === "Currículo smoke");
    expect(resume, "currículo semeado no bootstrap").toBeTruthy();
    await page.goto("#/curriculos");
    const card = page.locator("#view .resume-card", { hasText: "Currículo smoke" });
    await expect(card).toHaveCount(1);
    await expect(card).toContainText("Empresa Exemplo · versão 1");
    await expect(card).toContainText("Cobertura de requisitos:");
    await expect(card.locator(".status-pill").first()).toBeVisible();
    const base = `api/resumes/${encodeURIComponent(resume.id)}/files`;
    await expect(card.getByRole("link", { name: "Baixar PDF" })).toHaveAttribute("href", `${base}/pdf`);
    await expect(card.getByRole("link", { name: "Baixar DOCX" })).toHaveAttribute("href", `${base}/docx`);
    await expect(card.getByRole("link", { name: "JSON Resume" })).toHaveAttribute("href", `${base}/json`);
    const download = await page.request.get(`${base}/json`);
    expect(download.ok(), "download JSON Resume do currículo semeado").toBeTruthy();
    // Envio do PDF-base e importação do JSON Resume (#35) lado a lado.
    await expect(page.locator('#view form[data-form="base-resume"] input[type="file"]#base-resume-file')).toHaveAttribute("accept", "application/pdf,.pdf");
    const importInput = page.locator('#view form[data-form="json-resume-import"] input[type="file"]#json-resume-file');
    await expect(importInput).toHaveAttribute("accept", "application/json,.json");
    // O submit continua delegado no #view (handleForm): arquivo inválido é recusado no navegador, sem criar perfil.
    await importInput.setInputFiles({ name: "curriculo.json", mimeType: "application/json", buffer: Buffer.from("não é json") });
    await page.getByRole("button", { name: "Importar JSON Resume" }).click();
    await expect(page.locator("#toast-root .toast.error")).toContainText("O arquivo não é um JSON válido.");
    // Editar continua abrindo o editor legado (modal).
    await card.getByRole("button", { name: "Editar →" }).click();
    await expect(page.locator("#modal-root .modal")).toBeVisible();
    await expect(page.locator("#modal-root #resume-title")).toHaveValue("Currículo smoke");
    await page.keyboard.press("Escape");
    await expect(page.locator("#modal-root .modal")).toBeHidden();
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
});
