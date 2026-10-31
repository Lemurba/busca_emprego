/**
 * Smoke de UI (Playwright + axe): sobe o servidor já compilado (dist/src/server.js) com um
 * banco SQLite temporário e um token de dashboard só de teste. Rode com `npm run test:ui`
 * (faz o build antes). No CI o Chromium vem de `npx playwright install --with-deps chromium`;
 * localmente vale o PLAYWRIGHT_BROWSERS_PATH já configurado no ambiente.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

// O config é avaliado no processo principal e em cada worker: o diretório e o token são
// criados uma vez e herdados pelos workers via process.env.
process.env.RADAR_UI_SMOKE_DIR ??= mkdtempSync(join(tmpdir(), "radar-ui-smoke-"));
process.env.RADAR_UI_SMOKE_TOKEN ??= `ui-smoke-${"d".repeat(32)}`;
const port = Number(process.env.RADAR_UI_SMOKE_PORT ?? 8797);
const dashboardToken = process.env.RADAR_UI_SMOKE_TOKEN;
// Ambientes com um Chromium pré-instalado de outra revisão (ex.: containers de dev) apontam
// o executável aqui em vez de baixar o navegador da versão fixada do Playwright.
const chromiumExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;

function browser() {
  return {
    ...devices["Desktop Chrome"],
    ...(chromiumExecutable ? { launchOptions: { executablePath: chromiumExecutable } } : {})
  };
}

export default defineConfig({
  testDir: "test/ui",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 30_000,
  reporter: process.env.CI ? [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]] : "list",
  outputDir: "test-results",
  globalTeardown: "./test/ui/global-teardown.ts",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    locale: "pt-BR",
    timezoneId: "America/Sao_Paulo",
    trace: "retain-on-failure"
  },
  // Todas as specs dividem um servidor e um banco. A ordem é explícita (não a ordem alfabética
  // dos arquivos): o smoke vê o banco como ele o semeia; os fluxos rodam depois e deixam
  // perfil confirmado, termos aceitos e uma rodada no banco. Spec nova que dependa de banco
  // limpo entra no projeto "smoke"; a que aceite esse estado, num projeto que dependa de "fluxos".
  projects: [
    { name: "chromium", testMatch: "smoke.spec.ts", use: browser() },
    { name: "fluxos", testMatch: "sources-ats-flow.spec.ts", dependencies: ["chromium"], use: browser() }
  ],
  webServer: {
    command: "node dist/src/server.js",
    url: `http://127.0.0.1:${port}/api/ready`,
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: "ignore",
    stderr: "pipe",
    env: {
      PORT: String(port),
      RADAR_BIND_HOST: "127.0.0.1",
      RADAR_ENVIRONMENT: "development",
      RADAR_DB_PATH: join(process.env.RADAR_UI_SMOKE_DIR, "ui-smoke.sqlite"),
      RADAR_DASHBOARD_TOKEN: dashboardToken,
      RADAR_EXPIRATION_INTERVAL_MS: "3600000"
    }
  }
});
