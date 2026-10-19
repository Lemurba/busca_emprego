import { rmSync } from "node:fs";

/** Apaga o banco temporário do smoke de UI (criado em playwright.config.ts). */
export default function globalTeardown() {
  const directory = process.env.RADAR_UI_SMOKE_DIR;
  if (directory) rmSync(directory, { recursive: true, force: true });
}
