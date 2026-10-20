import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

// Utilitários sem estado compartilhados por src/db.ts e pelas migrações (sem import circular).

export function now() {
  return new Date().toISOString();
}

export function idFor(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 18);
}

export function parseJsonArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function insertAuditEvent(db: DatabaseSync, entityType: string, entityId: string, eventType: string, payload: unknown = {}) {
  db.prepare("INSERT INTO audit_events (entity_type, entity_id, event_type, payload, created_at) VALUES (?, ?, ?, ?, ?)").run(entityType, entityId, eventType, JSON.stringify(payload), now());
}
