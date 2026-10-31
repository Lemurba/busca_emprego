/**
 * Fluxos da etapa "Fontes e ATS" (auditoria 2026-10-30, §1.3 e §2) pelo navegador:
 *   1. aceitar os termos de uma fonte → registrar o teste de acesso → fonte pronta → iniciar rodada;
 *   2. Tenho interesse (palavra digitada) → Gerar currículo ATS → editar → portão do APROVO.
 * Usa o mesmo servidor e banco do smoke e roda depois dele por dependência explícita de
 * projeto ("fluxos" depende de "chromium" em playwright.config.ts): cria só dados próprios,
 * com nomes que o smoke não usa, e deixa no banco perfil confirmado, termos aceitos e rodada.
 * O perfil confirmado vem da API (a revisão do perfil pela UI é outra tela).
 */
import { readFileSync } from "node:fs";
import { AxeBuilder } from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";

const token = process.env.RADAR_UI_SMOKE_TOKEN ?? "";
const sample = JSON.parse(readFileSync(new URL("../fixtures/json-resume-sample.json", import.meta.url), "utf8"));
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

async function api(page: Page, method: string, path: string, data?: unknown) {
  const response = await page.request.fetch(path, { method, data, headers: data === undefined ? {} : { "content-type": "application/json" } });
  expect(response.ok(), `${method} ${path}: ${response.status()} ${await response.text()}`).toBeTruthy();
  return response.json();
}

/** Perfil confirmado a partir do JSON Resume de exemplo (cada fato revisado pela sessão). */
async function confirmedProfile(page: Page) {
  const draft = await api(page, "POST", "api/profiles/import/json-resume", sample);
  for (const fact of draft.facts as { id: string }[]) await api(page, "POST", `api/profiles/${draft.id}/facts/${fact.id}/review`, { state: "confirmed" });
  await api(page, "POST", `api/profiles/${draft.id}/confirm`, {});
}

/** Abre a página já com os dados semeados pela API (troca de hash não recarrega o bootstrap). */
async function openPage(page: Page, hash: string, heading: string) {
  await page.goto(hash);
  await page.reload();
  await expect(page.locator("#page-heading")).toHaveText(heading);
  await expect(page.locator("#view .loading-state")).toHaveCount(0);
}

async function axeBlocking(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  return results.violations.filter((violation) => BLOCKING_IMPACTS.has(violation.impact ?? "")).map((violation) => ({ rule: violation.id, nodes: violation.nodes.slice(0, 3).map((node) => node.target.join(" ")) }));
}

test.describe("fluxos de fontes e currículo ATS", () => {
  test("aceitar termos → fonte pronta → iniciar rodada", async ({ page }) => {
    const errors = watchConsole(page);
    await login(page);
    await confirmedProfile(page);
    await api(page, "POST", "api/sources", { id: "fonte-ui-s3", name: "Fonte UI S3", source_type: "job_board", domain: "fonte-ui-s3.example", enabled: true, auth_strategy: "none" });

    await openPage(page, "#/configuracoes", "Configurações");
    const row = page.locator('#view tr[data-source-row="fonte-ui-s3"]');
    await expect(row.locator(".status-pill")).toHaveText("Não pronta");
    await expect(row.locator("[data-source-reason]")).toHaveText("Termos de uso ainda não aceitos.");
    await expect(row).toContainText("Não aceitos");

    // Aceite de termos: o diálogo exige marcar a leitura antes de chamar a API.
    const dialog = page.locator("#dialog-root form.dialog");
    await row.getByRole("button", { name: "Aceitar termos de Fonte UI S3" }).click();
    await expect(dialog.getByRole("heading", { name: "Aceitar os termos de uso de Fonte UI S3?" })).toBeVisible();
    await dialog.getByRole("button", { name: "Aceitar termos" }).click();
    await expect(dialog.locator(".dialog-error")).toHaveText("Marque que leu os termos de uso para aceitar.");
    await dialog.getByLabel("Li os termos de uso de fonte-ui-s3.example e aceito a coleta de vagas nesta fonte.").check();
    await dialog.getByRole("button", { name: "Aceitar termos" }).click();
    await expect(page.locator("#toast-root")).toContainText("Termos de Fonte UI S3 aceitos. Ainda falta: Falta o teste de acesso.");
    await expect(row.locator(".status-pill")).toHaveText("Aguardando teste");
    await expect(row.locator("[data-source-reason]")).toHaveText("Falta o teste de acesso.");
    await expect(row.getByRole("button", { name: "Aceitar termos de Fonte UI S3" })).toHaveCount(0);

    // Teste de acesso registrado pelo painel: a fonte fica pronta (prontidão calculada).
    await row.getByRole("button", { name: "Registrar teste de acesso de Fonte UI S3" }).click();
    await dialog.getByLabel("Passou: a busca de vagas abriu normalmente.").check();
    await dialog.getByRole("button", { name: "Registrar resultado" }).click();
    await expect(row.locator(".status-pill")).toHaveText("Pronta");
    expect(await axeBlocking(page), "axe em Configurações com as ações de fonte").toEqual([]);

    // Saúde das buscas: prontidão calculada e início da rodada.
    await page.goto("#/saude");
    await expect(page.locator("#view tr", { hasText: "Fonte UI S3" }).first().locator(".status-pill")).toHaveText("Pronta");
    await page.getByRole("button", { name: "Iniciar rodada" }).click();
    await expect(dialog).toContainText("Fonte UI S3");
    const started = page.waitForResponse((response) => response.url().endsWith("/api/rounds") && response.request().method() === "POST");
    await dialog.getByRole("button", { name: "Iniciar rodada" }).click();
    expect((await started).status()).toBe(201);
    await expect(page.locator("#toast-root")).toContainText("Rodada iniciada com");
    const roundRow = page.locator("#view table tr", { hasText: "Fonte UI S3" }).filter({ has: page.locator('[data-label="Estado"]') }).first();
    await expect(roundRow.locator('[data-label="Estado"]')).toHaveText("Em execução");
    expect(errors, "erros de console").toEqual([]);
  });

  test("Tenho interesse digitado → Gerar currículo ATS → editar → portão do APROVO", async ({ page }) => {
    const errors = watchConsole(page);
    await login(page);
    const bootstrap = await api(page, "GET", "api/bootstrap");
    if (!bootstrap.activeProfile?.snapshot) await confirmedProfile(page);
    await api(page, "POST", "api/jobs", { title: "Engenharia de compressão UI", company: "Endframe UI", location: "Remoto", source: "fixture-ats", source_url: "https://jobs.example.test/fluxo-ats/1" });

    await openPage(page, "#/vagas", "Vagas");
    const row = page.locator("#view .data-table tbody tr", { hasText: "Engenharia de compressão UI" });
    // QA-12: vaga sem nota registrada não aparece como 0%.
    await expect(row.locator(".score")).toHaveText("Não avaliada");
    await page.getByRole("button", { name: "Detalhes de Engenharia de compressão UI" }).click();
    const modal = page.locator("#modal-root .modal");
    await expect(modal).toContainText("Engenharia de compressão UI");

    // QA-17: a palavra é digitada (minúsculas e espaços nas pontas valem); texto errado não envia.
    const dialog = page.locator("#dialog-root form.dialog");
    await modal.getByRole("button", { name: "Tenho interesse", exact: true }).click();
    await expect(dialog.getByRole("heading", { name: "Registrar interesse nesta vaga?" })).toBeVisible();
    const interest = dialog.getByLabel("Digite TENHO INTERESSE para confirmar");
    await interest.fill("tenho");
    await dialog.getByRole("button", { name: "Tenho interesse", exact: true }).click();
    await expect(dialog.locator(".dialog-error")).toHaveText("Digite TENHO INTERESSE para confirmar.");
    await interest.fill("  tenho interesse ");
    await dialog.getByRole("button", { name: "Tenho interesse", exact: true }).click();
    await expect(page.locator("#toast-root")).toContainText("Interesse registrado");

    // Gerar currículo ATS (não há mais o rascunho fixo "Preparar currículo").
    await expect(modal.getByRole("button", { name: "Preparar currículo" })).toHaveCount(0);
    const generated = page.waitForResponse((response) => response.url().endsWith("/api/resumes/generate") && response.request().method() === "POST");
    await modal.getByRole("button", { name: "Gerar currículo ATS" }).click();
    expect((await generated).status()).toBe(201);
    await expect(page.locator("#modal-root #resume-title")).toHaveValue("Currículo ATS — Engenharia de compressão UI");
    const content = page.locator("#modal-root #resume-content");
    // O modal foca o primeiro campo num requestAnimationFrame: espera o foco antes de editar.
    const titleFocused = () => expect(page.locator("#modal-root #resume-title")).toBeFocused();
    await titleFocused();
    const original = await content.inputValue();
    expect(original).toContain("EXPERIÊNCIA PROFISSIONAL");
    expect(original).not.toMatch(/contact_phone:|summary:|startDate:/u);

    // Edição com afirmação inventada: a checagem de fatos bloqueia o APROVO.
    await content.fill(`${original}\nGerente de Engenharia na Google (2020 – 2023)`);
    await page.locator("#modal-root").getByRole("button", { name: "Salvar alterações" }).click();
    await expect(page.locator("#toast-root")).toContainText("Currículo salvo.");
    await page.getByRole("button", { name: "Detalhes de Engenharia de compressão UI" }).click();
    await modal.getByRole("button", { name: "Revisar e aprovar currículo" }).click();
    await page.locator("#modal-root").getByRole("button", { name: "Aprovar versão salva…" }).click();
    await expect(dialog.getByRole("heading", { name: "Aprovar currículo" })).toBeVisible();
    await expect(dialog).toContainText("Aprovação bloqueada");
    await expect(dialog.getByRole("button", { name: "Aprovar esta versão" })).toBeDisabled();
    await expect(dialog.getByLabel("Digite APROVO para confirmar")).toHaveCount(0);
    await dialog.getByRole("button", { name: "Cancelar" }).click();

    // QA-07: sem a linha de e-mail, o teste de leitura do PDF reprova e o Aprovar fica desligado.
    await page.locator("#modal-root").getByRole("button", { name: "Cancelar" }).click();
    await page.getByRole("button", { name: "Detalhes de Engenharia de compressão UI" }).click();
    await modal.getByRole("button", { name: "Revisar e aprovar currículo" }).click();
    await titleFocused();
    await content.fill(original.replace(/^E-mail: .*\n/mu, ""));
    await page.locator("#modal-root").getByRole("button", { name: "Salvar alterações" }).click();
    await expect(page.locator("#toast-root")).toContainText("Currículo salvo.");
    await page.getByRole("button", { name: "Detalhes de Engenharia de compressão UI" }).click();
    await modal.getByRole("button", { name: "Revisar e aprovar currículo" }).click();
    const approveRequests: string[] = [];
    page.on("request", (request) => { if (/\/api\/resumes\/[^/]+\/approve$/u.test(request.url())) approveRequests.push(request.url()); });
    await page.locator("#modal-root").getByRole("button", { name: "Aprovar versão salva…" }).click();
    await expect(dialog).toContainText("Um parser não consegue ler parte deste currículo.");
    await expect(dialog.getByRole("button", { name: "Aprovar esta versão" })).toBeDisabled();
    await expect(dialog.getByLabel("Digite APROVO para confirmar")).toHaveCount(0);
    await dialog.getByRole("button", { name: "Cancelar" }).click();
    expect(approveRequests, "nenhum /approve com o PDF reprovado").toEqual([]);

    // Edição com respaldo (remove um destaque): revisão passa e o APROVO digitado aprova.
    await page.locator("#modal-root").getByRole("button", { name: "Cancelar" }).click();
    await page.getByRole("button", { name: "Detalhes de Engenharia de compressão UI" }).click();
    await modal.getByRole("button", { name: "Revisar e aprovar currículo" }).click();
    await titleFocused();
    await content.fill(original.replace("• Successfully won Techcrunch Disrupt\n", ""));
    await page.locator("#modal-root").getByRole("button", { name: "Salvar alterações" }).click();
    await expect(page.locator("#toast-root")).toContainText("Currículo salvo.");
    await page.getByRole("button", { name: "Detalhes de Engenharia de compressão UI" }).click();
    await modal.getByRole("button", { name: "Revisar e aprovar currículo" }).click();
    await page.locator("#modal-root").getByRole("button", { name: "Aprovar versão salva…" }).click();
    await expect(dialog).toContainText("A revisão ATS e a checagem de fatos passaram.");
    expect(await axeBlocking(page), "axe no diálogo de aprovação").toEqual([]);
    const approve = dialog.getByLabel("Digite APROVO para confirmar");
    await approve.fill("aprovado");
    await dialog.getByRole("button", { name: "Aprovar esta versão" }).click();
    await expect(dialog.locator(".dialog-error")).toHaveText("Digite APROVO para confirmar.");
    // O foco volta ao campo da palavra (não ao topo do diálogo), ligado à mensagem de erro.
    await expect(approve).toBeFocused();
    await expect(approve).toHaveAttribute("aria-invalid", "true");
    await expect(approve).toHaveAttribute("aria-describedby", (await dialog.locator(".dialog-error").getAttribute("id")) ?? "");
    const approved = page.waitForResponse((response) => /\/api\/resumes\/[^/]+\/approve$/u.test(response.url()));
    await approve.fill("aprovo");
    await dialog.getByRole("button", { name: "Aprovar esta versão" }).click();
    const response = await approved;
    expect(response.status()).toBe(200);
    expect(JSON.parse(response.request().postData() ?? "{}")).toEqual({ confirmation: "APROVO" });
    await expect(page.locator("#toast-root")).toContainText("Currículo aprovado.");
    expect(errors, "erros de console").toEqual([]);
  });

  test("sem perfil confirmado, a vaga explica o bloqueio e leva à revisão do perfil", async ({ page }) => {
    const errors = watchConsole(page);
    await login(page);
    const job = await api(page, "POST", "api/jobs", { title: "Vaga sem perfil UI", company: "Zeta UI", source: "fixture-ats", source_url: "https://jobs.example.test/fluxo-ats/2" });
    await api(page, "POST", `api/jobs/${job.id}/decision`, { decision: "interested", confirmation: "TENHO INTERESSE" });
    // Bootstrap sem perfil ativo: o mesmo estado de uma instalação nova.
    await page.route("**/api/bootstrap", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.activeProfile = null;
      await route.fulfill({ response, json: body });
    });
    await openPage(page, "#/vagas", "Vagas");
    await page.getByRole("button", { name: "Detalhes de Vaga sem perfil UI" }).click();
    const modal = page.locator("#modal-root .modal");
    await expect(modal).toContainText("Falta o perfil profissional confirmado.");
    await expect(modal.getByRole("button", { name: "Gerar currículo ATS" })).toHaveCount(0);
    await modal.getByRole("button", { name: "Revisar perfil" }).click();
    await expect(page.locator("#page-heading")).toHaveText("Saúde das buscas");
    await expect(modal).toBeHidden();
    await page.unrouteAll({ behavior: "ignoreErrors" });
    expect(errors, "erros de console").toEqual([]);
  });
});
