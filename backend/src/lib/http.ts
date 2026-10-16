import { randomUUID } from "node:crypto";

// One JSON shape for every answer: { ok, ... } on success, { ok: false, error, message } on failure.
export function jsonOk(body: Record<string, unknown>, status = 200): Response {
  return Response.json({ ok: true, ...body }, { status, headers: { "Cache-Control": "no-store" } });
}

export function jsonError(status: number, error: string, message: string, headers: Record<string, string> = {}, extra: Record<string, unknown> = {}): Response {
  return Response.json({ ok: false, error, message, ...extra }, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

export const requestId = (): string => randomUUID();

// Platform-set client IP (Vercel), else the first X-Forwarded-For entry. IPv6 is grouped by /64.
export function clientIp(headers: Headers): string {
  const raw = (headers.get("x-vercel-forwarded-for") ?? headers.get("x-real-ip") ?? headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
  if (!raw) return "unknown";
  if (raw.includes(":")) return raw.toLowerCase().split(":").slice(0, 4).join(":") + "::/64";
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(raw) ? raw : "unknown";
}

// Structured log line (Vercel captures stdout). Never pass secrets or answers here.
export function log(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));
}
