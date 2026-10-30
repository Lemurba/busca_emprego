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

  test("Visão geral: indicadores, gráficos clicáveis e filtro visual", async ({ page }) => {
    const errors = watchConsole(page);
    await login(page);
    await expect(page.locator("#view .metric-card")).toHaveCount(4);
    await expect(page.locator("#view .metric-card").first()).toContainText("Vagas abertas");
    // Fontes de descoberta: as três vagas semeadas vêm da fonte "fixture".
    const sourceBar = page.locator('#view .bar-list [data-chart-filter-type="source"][data-chart-filter-value="fixture"]');
    await expect(sourceBar).toHaveAttribute("aria-pressed", "false");
    await expect(sourceBar.locator("strong")).toHaveText("3");
    await expect(page.locator("#view .donut-chart")).toHaveAttribute("aria-label", /Distribuição das 3 vagas/);
    await expect(page.locator("#view .donut-legend .legend-item")).toHaveCount(5);
    // Clicar filtra (re-render pelo Preact no lugar) e o resumo do filtro aparece; clicar de novo limpa.
    await sourceBar.click();
    await expect(sourceBar).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#view .chart-filter-summary")).toContainText("Filtro: fixture · 3 de 3 vagas");
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
    await expect(page.locator("#view .chart-filter-summary").first()).toContainText("Filtro: Recife, PE · 1 de 3 vagas");
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
    // O bootstrap recarrega depois do envio; descarta rotas ainda em voo para o fim do teste não
    // fechar a página no meio de um route.fetch (corrida vista na CI).
    await page.unrouteAll({ behavior: "ignoreErrors" });
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
