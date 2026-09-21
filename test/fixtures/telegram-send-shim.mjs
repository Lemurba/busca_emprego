#!/usr/bin/env node
/**
 * Fixture de envio Telegram usado nos testes: lê a mensagem do stdin, grava em
 * RADAR_TELEGRAM_SHIM_OUT e responde o JSON que o `hermes send --json` devolveria.
 * RADAR_TELEGRAM_SHIM_MODE=fail simula falha de entrega.
 */
import { appendFileSync } from "node:fs";

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const out = process.env.RADAR_TELEGRAM_SHIM_OUT;
  if (out) appendFileSync(out, `${JSON.stringify({ chat_id: 424242, text: input })}\n`);
  if (process.env.RADAR_TELEGRAM_SHIM_MODE === "fail") {
    process.stderr.write("Chat not found\n");
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, chat_id: 424242, message_id: 777 })}\n`);
});
