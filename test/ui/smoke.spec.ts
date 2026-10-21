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

/** Chamada à API com a sessão da página (cookie do login). */
async function pageApi(page: Page, method: string, path: string, data?: unknown) {
  const response = await page.request.fetch(path, { method, data, headers: data === undefined ? {} : { "content-type": "application/json" } });
  expect(response.ok(), `${method} ${path}: ${response.status()} ${await response.text()}`).toBeTruthy();
  return response.json();
}

/** PNG 1×1 transparente: os tiles do OpenStreetMap não saem da máquina no teste. */
const TILE_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

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

  test("Visão geral: indicadores, gráficos clicáveis e filtro visual", async ({ page }) => {
    const errors = watchConsole(page);
    await login(page);
    await expect(page.locator("#view .metric-card")).toHaveCount(4);
    await expect(page.locator("#view .metric-card").first()).toContainText("Vagas abertas");
    // Fontes de descoberta: as duas vagas semeadas vêm da fonte "fixture".
    const sourceBar = page.locator('#view .bar-list [data-chart-filter-type="source"][data-chart-filter-value="fixture"]');
    await expect(sourceBar).toHaveAttribute("aria-pressed", "false");
    await expect(sourceBar.locator("strong")).toHaveText("2");
    await expect(page.locator("#view .donut-chart")).toHaveAttribute("aria-label", /Distribuição das 2 vagas/);
    await expect(page.locator("#view .donut-legend .legend-item")).toHaveCount(5);
    // Clicar filtra (re-render pelo Preact no lugar) e o resumo do filtro aparece; clicar de novo limpa.
    await sourceBar.click();
    await expect(sourceBar).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#view .chart-filter-summary")).toContainText("Filtro: fixture · 2 de 2 vagas");
    await page.locator("#view [data-clear-chart-filter]").click();
    await expect(page.locator("#view .chart-filter-summary")).toHaveCount(0);
    await expect(sourceBar).toHaveAttribute("aria-pressed", "false");
    expect(errors, "erros de console").toEqual([]);
  });

  test("Análises: gráficos e mapa (Leaflet) montado uma vez, atualizado no filtro e removido ao sair", async ({ page }) => {
    const errors = watchConsole(page);
    await page.route("https://tile.openstreetmap.de/**", (route) => route.fulfill({ status: 200, contentType: "image/png", body: TILE_PNG }));
    // Sem animações (flyTo e view transition do Expandir): o teste não espera segundos por elas.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await login(page);
    // Coordenadas nas duas vagas semeadas para o mapa ter marcadores.
    const bootstrap = await pageApi(page, "GET", "api/bootstrap");
    const coords: Record<string, [number, number]> = { "Pessoa desenvolvedora TypeScript": [-23.55, -46.63], "Engenharia de dados": [-8.05, -34.9] };
    for (const job of bootstrap.jobs as { id: string; title: string }[]) {
      const point = coords[job.title];
      if (point) await pageApi(page, "PATCH", `api/jobs/${job.id}`, { latitude: point[0], longitude: point[1] });
    }
    await page.goto("#/analises");
    await page.reload();
    await expect(page.locator("#page-heading")).toHaveText("Análises");
    await expect(page.locator("#view .salary-chart .salary-column")).toHaveCount(1);
    await expect(page.locator('#view .pipeline-block .bar-list [data-chart-filter-type="status"]').first()).toBeVisible();
    await expect(page.locator("#view .map-job-list")).toHaveAttribute("role", "region");
    await expect(page.locator("#view .map-job-list")).toHaveAttribute("aria-label", "Vagas no mapa");
    await expect(page.locator("#view .map-job-list")).toHaveAttribute("tabindex", "0");

    // Mapa desligado por padrão (consentimento); "Carregar mapa" liga e monta o Leaflet.
    await expect(page.locator("#view .map-consent")).toContainText("Mapa desligado");
    await page.locator("#view [data-enable-map]").click();
    const map = page.locator("#view #opportunities-map");
    await expect(map).toHaveClass(/leaflet-container/);
    await expect(page.locator("#view .leaflet-container")).toHaveCount(1);
    await expect(map.locator(".leaflet-interactive")).toHaveCount(2);
    const leafletId = await map.evaluate((element) => (element as unknown as { _leaflet_id: number })._leaflet_id);

    // Filtro visual: re-render no lugar troca só os marcadores (mesma instância, sem segundo mapa).
    await page.locator('#view .location-row[data-chart-filter-value="Recife, PE"]').click();
    await expect(page.locator("#view .chart-filter-summary").first()).toContainText("Filtro: Recife, PE · 1 de 2 vagas");
    await expect(map.locator(".leaflet-interactive")).toHaveCount(1);
    await expect(page.locator("#view .leaflet-container")).toHaveCount(1);
    expect(await map.evaluate((element) => (element as unknown as { _leaflet_id: number })._leaflet_id)).toBe(leafletId);
    await page.locator("#view [data-clear-chart-filter]").first().click();
    await expect(map.locator(".leaflet-interactive")).toHaveCount(2);

    // Lista "Vagas no mapa" centraliza e marca a vaga; Expandir/Reduzir vem do estado.
    const mapJob = page.locator("#view .map-job", { hasText: "Engenharia de dados" });
    await mapJob.click();
    await expect(mapJob).toHaveClass(/selected/);
    const expand = page.locator("#view [data-expand-map]");
    await expand.click();
    await expect(expand).toHaveText("Reduzir mapa");
    await expect(expand).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#view .map-shell")).toHaveClass(/is-expanded/);
    await expect(page.locator("body")).toHaveClass(/map-expanded/);
    await expand.click();
    await expect(expand).toHaveText("Expandir mapa");
    await expect(page.locator("#view .map-shell")).not.toHaveClass(/is-expanded/);

    const results = await new AxeBuilder({ page }).analyze();
    const blocking = results.violations.filter((violation) => BLOCKING_IMPACTS.has(violation.impact ?? ""));
    expect(blocking.map((violation) => ({ rule: violation.id, nodes: violation.nodes.slice(0, 3).map((node) => node.target.join(" ")) })), "axe com o mapa ligado").toEqual([]);

    // Sair desmonta (map.remove); voltar monta uma instância nova, sem "Map container is already initialized".
    await page.locator('.sidebar [data-page="overview"]').click();
    await expect(page.locator("#page-heading")).toHaveText("Visão geral");
    await expect(page.locator("#view .leaflet-container")).toHaveCount(0);
    await page.locator('.sidebar [data-page="analytics"]').click();
    await expect(page.locator("#page-heading")).toHaveText("Análises");
    await expect(page.locator("#view .leaflet-container")).toHaveCount(1);
    await expect(map.locator(".leaflet-interactive")).toHaveCount(2);
    // Recarregar os dados com as mesmas vagas mantém o mapa.
    await page.locator("#refresh-button").click();
    await expect(page.locator("#sync-label")).toContainText("Atualizado");
    await expect(page.locator("#view .leaflet-container")).toHaveCount(1);
    await expect(map.locator(".leaflet-interactive")).toHaveCount(2);
    expect(errors, "erros de console").toEqual([]);
  });

  test("Quadro: vaga semeada na coluna certa; Mover para… e arrastar avançam a etapa pela API", async ({ page }) => {
    const errors = watchConsole(page);
    await login(page);
    await page.goto("#/quadro");
    await expect(page.locator("#page-heading")).toHaveText("Quadro");
    const column = (title: string) => page.locator("#view .board-column").filter({ has: page.locator(".column-title", { hasText: title }) });
    const card = page.locator("#view .job-card", { hasText: "Engenharia de dados" });
    const jobStatus = async () => {
      const bootstrap = await pageApi(page, "GET", "api/bootstrap");
      return (bootstrap.jobs as { title: string; status: string }[]).find((job) => job.title === "Engenharia de dados")?.status;
    };
    // Recém-criada (found): coluna Entrada, arrastável, só a próxima etapa no "Mover para…".
    await expect(column("Entrada").locator(".job-card", { hasText: "Engenharia de dados" })).toBeVisible();
    await expect(card).toHaveAttribute("draggable", "true");
    const select = card.locator("select.move-select");
    await expect(select.locator("option")).toHaveText(["Mover para…", "Entrada"]);

    // Mover para… (found → validation): fica na mesma coluna, select volta ao início com as novas opções.
    await select.selectOption("validation");
    await expect(page.locator("#toast-root")).toContainText("Vaga movida para Entrada.");
    await expect.poll(jobStatus).toBe("validation");
    await expect(select.locator("option")).toHaveText(["Mover para…", "Match forte", "Em revisão"]);
    await expect(select).toHaveValue("");
    await expect(select).toBeEnabled();

    // Dicas de destino durante o arraste: etapas válidas destacadas, as outras esmaecidas; somem ao soltar.
    const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
    await card.dispatchEvent("dragstart", { dataTransfer });
    await expect(column("Match forte").locator(".column-drop")).toHaveClass(/drop-valid/);
    await expect(column("Em revisão").locator(".column-drop")).toHaveClass(/drop-valid/);
    await expect(column("Entrada").locator(".column-drop")).toHaveClass(/drop-invalid/);
    await expect(column("Preparar").locator(".column-drop")).toHaveClass(/drop-invalid/);
    await card.dispatchEvent("dragend", { dataTransfer });
    await expect(page.locator("#view .column-drop.drop-valid, #view .column-drop.drop-invalid")).toHaveCount(0);

    // Arrastar para "Em revisão" (validation → review): o cartão muda de coluna.
    await card.dragTo(column("Em revisão").locator(".column-drop"));
    await expect(column("Em revisão").locator(".job-card", { hasText: "Engenharia de dados" })).toBeVisible();
    await expect.poll(jobStatus).toBe("review");
    await expect(page.locator("#view .column-drop.drop-valid, #view .column-drop.drop-invalid, #view .column-drop.drag-over")).toHaveCount(0);
    expect(errors, "erros de console").toEqual([]);
  });
});
