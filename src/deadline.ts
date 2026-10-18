// Prazos e datas do Radar (issue #22): módulo único, sem dependências de Node, usado pelo
// servidor (src/db.ts) e pelo navegador (public/app.ts, empacotado pelo esbuild).
// Regra: prazo só com data (AAAA-MM-DD) vale até 23:59:59.999 daquele dia no fuso do Radar
// (`RADAR_TZ`, padrão America/Sao_Paulo) — nunca no fuso do processo/container.

export const DEFAULT_RADAR_TZ = "America/Sao_Paulo";

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/u;
const DATE_TIME_WITH_OFFSET = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/u;

/** Fuso válido para Intl; senão o padrão do Radar. */
export function resolveTimeZone(value: string | null | undefined): string {
  const zone = String(value ?? "").trim();
  if (!zone) return DEFAULT_RADAR_TZ;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return DEFAULT_RADAR_TZ;
  }
}

function validCalendarDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** ISO 8601 aceito para prazos: `AAAA-MM-DD` ou data-hora com offset (`Z` ou `±HH:MM`). */
export function isIsoDeadline(value: string): boolean {
  const text = value.trim();
  const dateOnly = DATE_ONLY.exec(text);
  if (dateOnly) return validCalendarDate(Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3]));
  const dateTime = DATE_TIME_WITH_OFFSET.exec(text);
  if (!dateTime) return false;
  if (!validCalendarDate(Number(dateTime[1]), Number(dateTime[2]), Number(dateTime[3]))) return false;
  if (Number(dateTime[4]) > 23 || Number(dateTime[5]) > 59 || Number(dateTime[6] ?? 0) > 59) return false;
  return Number.isFinite(Date.parse(text));
}

/** Partes de calendário de um instante no fuso indicado. */
function zonedParts(ms: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

/** Offset (ms) do fuso no instante dado: horário local − UTC. */
function zoneOffsetMs(ms: number, timeZone: string): number {
  const local = zonedParts(ms, timeZone);
  const asUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
  return asUtc - (ms - (((ms % 1000) + 1000) % 1000));
}

/** Instante UTC de um horário de parede no fuso (resolve horário de verão em duas passadas). */
function zonedWallTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, second: number, millis: number, timeZone: string): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second, millis);
  let utc = wall - zoneOffsetMs(wall, timeZone);
  utc = wall - zoneOffsetMs(utc, timeZone);
  return utc;
}

/**
 * Instante (ms) em que o prazo deixa de valer. Data pura → 23:59:59.999 no fuso do Radar.
 * Texto legado fora de ISO cai no `Date.parse`; inválido → null.
 */
export function deadlineLimitMs(deadline: string | null | undefined, timeZone = DEFAULT_RADAR_TZ): number | null {
  if (!deadline) return null;
  const value = String(deadline).trim();
  const dateOnly = DATE_ONLY.exec(value);
  if (dateOnly) {
    const [year, month, day] = [Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3])];
    if (!validCalendarDate(year, month, day)) return null;
    return zonedWallTimeToUtc(year, month, day, 23, 59, 59, 999, resolveTimeZone(timeZone));
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function deadlinePassed(deadline: string | null | undefined, nowMs = Date.now(), timeZone = DEFAULT_RADAR_TZ): boolean {
  const limit = deadlineLimitMs(deadline, timeZone);
  return limit != null && limit < nowMs;
}

/** Dia de calendário (no fuso do Radar) de um valor: data pura é o próprio dia. */
function calendarDay(value: string, timeZone: string): { year: number; month: number; day: number } | null {
  const dateOnly = DATE_ONLY.exec(value.trim());
  if (dateOnly) return { year: Number(dateOnly[1]), month: Number(dateOnly[2]), day: Number(dateOnly[3]) };
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  const parts = zonedParts(ms, resolveTimeZone(timeZone));
  return { year: parts.year, month: parts.month, day: parts.day };
}

/** Dias de calendário entre hoje e o prazo, no fuso do Radar (0 = encerra hoje). */
export function daysUntilDeadline(deadline: string | null | undefined, nowMs = Date.now(), timeZone = DEFAULT_RADAR_TZ): number | null {
  if (!deadline) return null;
  const target = calendarDay(String(deadline), timeZone);
  if (!target) return null;
  const today = zonedParts(nowMs, resolveTimeZone(timeZone));
  return Math.round((Date.UTC(target.year, target.month - 1, target.day) - Date.UTC(today.year, today.month - 1, today.day)) / 86_400_000);
}

/**
 * Formata data/instante em pt-BR no fuso do Radar. Data pura é exibida como o próprio dia
 * (sem deslocar para o dia anterior por causa de meia-noite UTC).
 */
export function formatRadarDate(value: string | null | undefined, options: Intl.DateTimeFormatOptions, timeZone = DEFAULT_RADAR_TZ): string | null {
  if (!value) return null;
  const text = String(value).trim();
  const dateOnly = DATE_ONLY.exec(text);
  if (dateOnly) {
    const [year, month, day] = [Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3])];
    if (!validCalendarDate(year, month, day)) return null;
    return new Intl.DateTimeFormat("pt-BR", { ...options, timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, day, 12)));
  }
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) return null;
  return new Intl.DateTimeFormat("pt-BR", { ...options, timeZone: resolveTimeZone(timeZone) }).format(new Date(ms));
}
