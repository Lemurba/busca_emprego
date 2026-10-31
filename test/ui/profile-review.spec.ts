/**
 * Onboarding do perfil profissional pela UI (#49): PDF-base → "Criar perfil a partir deste PDF"
 * → revisão do rascunho (Confirmar/Rejeitar, entrevista, "Confirmar todos os pendentes") →
 * "Confirmar perfil" → "Perfil ativo vN"; nova versão e descarte; import de JSON Resume levando
 * direto à revisão. Sem erro de console e sem violação séria/crítica do axe na revisão.
 *
 * Usa o mesmo servidor e banco do smoke (playwright.config.ts); os perfis criados aqui não
 * atrapalham o smoke, que só confere a renderização das páginas.
 */
import { readFileSync } from "node:fs";
import { AxeBuilder } from "@axe-core/playwright";
import { type Locator, type Page, expect, test } from "@playwright/test";
import { PDFDocument, StandardFonts } from "pdf-lib";

const token = process.env.RADAR_UI_SMOKE_TOKEN ?? "";
const BLOCKING_IMPACTS = new Set(["serious", "critical"]);
const jsonResume = readFileSync(new URL("../fixtures/json-resume-sample.json", import.meta.url));

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

async function expectAxeClean(page: Page) {
  // Os avisos (toasts) entram com animação de opacidade: no meio dela o axe mede contraste de
  // um texto semitransparente. O conteúdo deles não é o alvo desta suíte.
  const results = await new AxeBuilder({ page }).exclude("#toast-root").analyze();
  const blocking = results.violations.filter((violation) => BLOCKING_IMPACTS.has(violation.impact ?? ""));
  expect(blocking.map((violation) => ({ rule: violation.id, help: violation.help, nodes: violation.nodes.slice(0, 3).map((node) => node.target.join(" ")) })), "violações sérias/críticas do axe").toEqual([]);
}

/** Descarta rascunhos que um teste anterior (ou uma falha) deixou para trás. */
async function discardDrafts(page: Page) {
  const bootstrap = await (await page.request.get("api/bootstrap")).json();
  for (const draft of bootstrap.draftProfiles ?? []) {
    const response = await page.request.delete(`api/profiles/${encodeURIComponent(draft.id)}`);
    expect(response.ok(), `descartar rascunho v${draft.version}: ${response.status()} ${await response.text()}`).toBeTruthy();
  }
}

/** PDF de duas páginas com texto real (e-mail, telefone, link e seções), como um currículo exportado. */
async function resumePdf() {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const first = document.addPage();
  const lines = ["Joana Pereira", "joana.pereira@example.com", "+55 11 91234-5678", "Resumo", "Analista de dados com foco em SQL e Python"];
  for (const [index, text] of lines.entries()) first.drawText(text, { x: 50, y: 760 - index * 20, size: 12, font });
  const second = document.addPage();
  for (const [index, text] of ["Portfolio: https://portfolio.example.com/joana", "Competencias", "SQL, Python, Power BI"].entries()) second.drawText(text, { x: 50, y: 760 - index * 20, size: 12, font });
  return Buffer.from(await document.save());
}

/** Linha de uma informação pelo rótulo exato (o trecho de evidência pode repetir valores vizinhos). */
const factRow = (scope: Locator, label: string) => scope.locator(".profile-fact").filter({ has: scope.page().locator("strong", { hasText: new RegExp(`^${label}$`, "u") }) });
const confirmButton = (page: Page) => page.locator("#view .profile-draft").getByRole("button", { name: "Confirmar perfil" });

test.describe("perfil profissional: revisão e confirmação (#49)", () => {
  test("PDF-base → rascunho → revisar → entrevista → confirmar → Perfil ativo; nova versão e descarte", async ({ page }) => {
    const errors = watchConsole(page);
    await login(page);
    await discardDrafts(page);

    await page.goto("#/curriculos");
    await page.locator("#base-resume-title").fill("Currículo Joana");
    await page.locator("#base-resume-file").setInputFiles({ name: "joana.pdf", mimeType: "application/pdf", buffer: await resumePdf() });
    await page.getByRole("button", { name: "Enviar PDF" }).click();
    await expect(page.locator("#toast-root .toast").last()).toContainText("PDF salvo na biblioteca.");

    const card = page.locator("#view .resume-card", { hasText: "Currículo Joana" });
    // §2 "Ver extração do PDF": o texto lido (de onde saem os fatos) abre num modal.
    await card.getByRole("button", { name: "Ver texto lido de Currículo Joana" }).click();
    const extraction = page.locator("#modal-root .modal");
    await expect(extraction.getByRole("heading", { name: "Texto lido de Currículo Joana" })).toBeVisible();
    await expect(extraction.getByRole("region", { name: "Texto extraído do PDF" })).toContainText("joana.pereira@example.com");
    await expectAxeClean(page);
    await page.keyboard.press("Escape");
    await expect(extraction).toBeHidden();
    await card.getByRole("button", { name: "Criar perfil a partir deste PDF" }).click();
    await expect(page).toHaveURL(/#\/saude/u);
    const heading = page.locator("#profile-draft-heading");
    await expect(heading).toHaveText(/Perfil em rascunho \(v\d+\)/u);
    await expect(heading).toBeFocused();

    // Pendentes bloqueiam a confirmação, com o motivo visível (espelha PROFILE_FACTS_UNCONFIRMED).
    const panel = page.locator("#view .profile-draft");
    await expect(confirmButton(page)).toBeDisabled();
    await expect(panel.locator("#profile-confirm-reason")).toContainText("para revisar");
    // Cada informação mostra rótulo, valor, origem e a página de onde saiu.
    const email = factRow(panel, "E-mail");
    await expect(email).toContainText("joana.pereira@example.com");
    await expect(email).toContainText("Origem: extraído do PDF");
    await expect(email).toContainText("página 1");
    await expect(factRow(panel, "Link profissional")).toContainText("página 2");
    await expectAxeClean(page);

    // Rejeitar uma informação e confirmar outra uma a uma.
    const phone = factRow(panel, "Telefone");
    await phone.getByRole("button", { name: /^Rejeitar Telefone: /u }).click();
    await expect(phone.locator(".status-pill")).toHaveText("Rejeitado");
    // QAF-15: o nome do botão traz o valor (tipos repetidos não ficam com nomes iguais).
    await email.getByRole("button", { name: "Confirmar E-mail: joana.pereira@example.com" }).click();
    await expect(email.locator(".status-pill")).toHaveText("Confirmado");

    // Entrevista dos eliminatórios no rascunho.
    await panel.getByLabel("Anos de experiência").fill("6");
    await panel.getByLabel("Remoto").check();
    await panel.getByRole("button", { name: "Salvar respostas" }).click();
    await expect(page.locator("#toast-root .toast").last()).toContainText("respostas salvas no rascunho");
    await expect(factRow(panel, "Anos de experiência")).toContainText("Declaração sua");

    await panel.getByRole("button", { name: /Confirmar todos os pendentes/u }).click();
    await expect(page.locator("#toast-root .toast").last()).toContainText("confirmad");
    await expect(confirmButton(page)).toBeEnabled();
    await expect(panel.locator("#profile-confirm-reason")).toHaveCount(0);

    await confirmButton(page).click();
    const dialog = page.locator("#dialog-root form[role=alertdialog]");
    await expect(dialog).toContainText("Confirmar o perfil");
    await dialog.getByRole("button", { name: "Confirmar perfil" }).click();
    await expect(page.locator("#view .profile-draft")).toHaveCount(0);
    const active = page.locator("#view .status-pill", { hasText: /^Perfil ativo v\d+$/u });
    await expect(active).toBeVisible();
    const activeLabel = await active.textContent();

    // Nova versão a partir do confirmado → rascunho N+1 → descartar.
    await page.getByRole("button", { name: "Criar nova versão" }).click();
    await expect(page.locator("#profile-draft-heading")).toHaveText(/Perfil em rascunho \(v\d+\)/u);
    await expect(confirmButton(page)).toBeEnabled();
    await page.locator("#view .profile-draft").getByRole("button", { name: "Descartar rascunho" }).click();
    await page.locator("#dialog-root form[role=alertdialog]").getByRole("button", { name: "Descartar" }).click();
    await expect(page.locator("#view .profile-draft")).toHaveCount(0);
    await expect(page.locator("#view .status-pill", { hasText: /^Perfil ativo v\d+$/u })).toHaveText(activeLabel ?? "");

    expect(errors, "erros de console").toEqual([]);
  });

  test("import de JSON Resume leva à revisão; confirmar pendentes e o perfil vira o ativo", async ({ page }) => {
    const errors = watchConsole(page);
    await login(page);
    await discardDrafts(page);

    await page.goto("#/curriculos");
    await page.locator("#json-resume-file").setInputFiles({ name: "richard.json", mimeType: "application/json", buffer: jsonResume });
    await page.getByRole("button", { name: "Importar JSON Resume" }).click();
    await expect(page).toHaveURL(/#\/saude/u);
    const heading = page.locator("#profile-draft-heading");
    await expect(heading).toBeFocused();
    const version = Number((await heading.textContent())?.match(/v(\d+)/u)?.[1]);
    expect(version).toBeGreaterThan(0);

    const panel = page.locator("#view .profile-draft");
    await expect(panel).toContainText("JSON Resume importado");
    await expect(factRow(panel, "Nome")).toContainText("/basics/name");
    // QAF-14: fatos estruturados do JSON Resume em texto legível, sem as chaves em inglês.
    const values = await panel.locator(".profile-fact-value").allTextContents();
    expect(values.filter((value) => /\b(?:institution|studyType|startDate|network|username):/u.test(value)), "chaves cruas do JSON Resume").toEqual([]);
    // QAF-15: nenhum par de botões Confirmar/Rejeitar com o mesmo nome acessível.
    const names = await panel.locator(".profile-fact button").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")));
    expect(names.filter((name, index) => names.indexOf(name) !== index), "nomes de botão repetidos").toEqual([]);
    await expect(confirmButton(page)).toBeDisabled();
    await expectAxeClean(page);

    await panel.getByRole("button", { name: /Confirmar todos os pendentes \(18\)/u }).click();
    await expect(confirmButton(page)).toBeEnabled();
    await confirmButton(page).click();
    await page.locator("#dialog-root form[role=alertdialog]").getByRole("button", { name: "Confirmar perfil" }).click();
    await expect(page.locator("#view .status-pill", { hasText: `Perfil ativo v${version}` })).toBeVisible();
    await expect(page.locator("#toast-root .toast").last()).toContainText(`Perfil ativo v${version}.`);
    await expectAxeClean(page);
    expect(errors, "erros de console").toEqual([]);
  });
});
