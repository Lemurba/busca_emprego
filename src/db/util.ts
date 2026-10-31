import type { DatabaseSync } from "node:sqlite";

// Utilitários sem estado compartilhados por src/db.ts e pelas migrações (sem import circular).

export function now() {
  return new Date().toISOString();
}

// Id determinístico: implementação única em src/hash.ts (TD-11).
export { idFor } from "../hash.js";

export function parseJsonArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** Objeto JSON (texto ou já objeto); qualquer outra coisa vira `{}`. */
export function parseObject(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

export function insertAuditEvent(db: DatabaseSync, entityType: string, entityId: string, eventType: string, payload: unknown = {}) {
  db.prepare("INSERT INTO audit_events (entity_type, entity_id, event_type, payload, created_at) VALUES (?, ?, ?, ?, ?)").run(entityType, entityId, eventType, JSON.stringify(payload), now());
}
