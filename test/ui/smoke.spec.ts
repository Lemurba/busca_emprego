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

  test("Empresas: cartões das empresas semeadas com vagas e salário médio", async ({ page }) => {
    const errors = watchConsole(page);
    await login(page);
    await page.goto("#/empresas");
    const card = (name: string) => page.locator("#view .company-card").filter({ has: page.getByRole("heading", { name, exact: true }) });
    await expect(card("Empresa Exemplo").locator(".chip")).toHaveText("1 vaga");
    await expect(card("Empresa Exemplo").locator(".company-stat strong").first()).toContainText("/mês");
    await expect(card("Empresa Exemplo")).toContainText("estimado em 1 vaga");
    await expect(card("Outra Empresa").locator(".company-stat strong").first()).toHaveText("Não informado");
    await expect(card("Outra Empresa").locator(".tag")).toHaveText(["fixture"]);
    // Recarregar os dados re-renderiza no lugar sem duplicar cartões.
    const total = await page.locator("#view .company-card").count();
    await page.locator("#refresh-button").click();
    await expect(page.locator("#sync-label")).toContainText("Atualizado");
    await expect(page.locator("#view .company-card")).toHaveCount(total);
    expect(errors, "erros de console").toEqual([]);
  });

  test("Configurações: interruptor de privacidade, re-render e painel de conectores", async ({ page }) => {
    const errors = watchConsole(page);
    await login(page);
    await page.goto("#/configuracoes");
    const mapToggle = page.locator('#view input[data-pref="map"]');
    await expect(mapToggle).not.toBeChecked();
    // Recarrega os dados antes: o Preact mantém o mesmo input; o aviso deve sair uma vez só.
    await page.locator("#refresh-button").click();
    await expect(page.locator("#sync-label")).toContainText("Atualizado");
    await mapToggle.check();
    await expect(page.locator("#toast-root .toast", { hasText: "Mapa ligado." })).toHaveCount(1);
    expect(await page.evaluate(() => localStorage.getItem("radar-map-consent"))).toBe("1");
    await page.reload();
    await expect(page.locator("#page-heading")).toHaveText("Configurações");
    await expect(mapToggle).toBeChecked();
    await mapToggle.uncheck();
    await expect(page.locator("#toast-root .toast", { hasText: "Mapa desligado." })).toHaveCount(1);
    expect(await page.evaluate(() => localStorage.getItem("radar-map-consent"))).toBe("0");

    // Ações delegadas continuam funcionando: + Fonte abre o modal.
    await page.getByRole("button", { name: "Fonte", exact: true }).click();
    await expect(page.locator("#modal-root .modal")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#modal-root .modal")).toBeHidden();

    // Painel de conectores: carrega, adiciona, pausa e remove uma empresa pela API.
    const panel = page.locator("#view [data-connector-panel]");
    await expect(panel).not.toHaveAttribute("aria-busy");
    await panel.locator("#connector-id").selectOption("lever");
    await expect(panel.locator("#connector-slug-hint")).toHaveText("empresa: jobs.lever.co/<empresa>");
    await panel.locator("#connector-slug").fill("ui-smoke-co");
    await panel.locator("#connector-name").fill("Empresa Conector Smoke");
    const created = page.waitForResponse((response) => response.url().endsWith("/api/connectors/companies") && response.request().method() === "POST");
    await panel.getByRole("button", { name: "Adicionar empresa" }).click();
    expect((await created).status()).toBe(201);
    const row = panel.locator("tbody tr", { hasText: "Empresa Conector Smoke" });
    await expect(row).toContainText("Lever · ui-smoke-co");
    await expect(page.locator("#toast-root .toast", { hasText: "Empresa adicionada à coleta automática." })).toHaveCount(1);
    await expect(panel.locator("#connector-slug")).toHaveValue("");
    await expect(row.locator(".status-pill").last()).toHaveText("Ativa");
    await row.getByRole("button", { name: "Pausar" }).click();
    await expect(row.locator(".status-pill").last()).toHaveText("Pausada");
    await expect(row.getByRole("button", { name: "Ativar" })).toBeEnabled();
    // Re-render da página (recarga de dados) não apaga nem duplica o painel.
    await page.locator("#refresh-button").click();
    await expect(page.locator("#sync-label")).toContainText("Atualizado");
    await expect(page.locator("#view [data-connector-panel]")).toHaveCount(1);
    await expect(row).toHaveCount(1);
    await expect(panel.getByText("Carregando…")).toHaveCount(0);
    await row.getByRole("button", { name: "Remover" }).click();
    await page.getByRole("alertdialog", { name: "Remover empresa?" }).getByRole("button", { name: "Remover" }).click();
    await expect(row).toHaveCount(0);

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations.filter((violation) => BLOCKING_IMPACTS.has(violation.impact ?? "")).map((violation) => violation.id), "violações sérias/críticas do axe com o painel carregado").toEqual([]);
    expect(errors, "erros de console").toEqual([]);
  });
});
