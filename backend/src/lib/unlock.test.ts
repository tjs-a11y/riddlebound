import { beforeEach, describe, expect, it } from "vitest";
import { hashAnswer } from "./answers";
import { setRateStoreForTests } from "./ratelimit";
import { handleUnlock, type UnlockDeps } from "./unlock";

const PEPPER = "p".repeat(48);
const USER = "00000000-0000-0000-0000-0000000000a1";
let ipCounter = 0;

function makeDeps(over: Partial<UnlockDeps> = {}) {
  const recorded: string[] = [];
  const deps: UnlockDeps = {
    pepper: PEPPER,
    urlTtlSeconds: 300,
    authenticate: async (req) => (req.headers.get("authorization") === "Bearer good-token-good-token-1234" ? { id: USER } : null),
    hasAccess: async (_u, book) => book === "s309-b1",
    getAsset: async (book, asset) =>
      book === "s309-b1" && asset === "kcal-0531"
        ? { hashed_answer: hashAnswer(PEPPER, book, asset, "outside"), encrypted_content_url: "riddlebound-assets/s309-b1/walt.mp3" }
        : null,
    recordUnlock: async (u, b, a) => { recorded.push(`${u}/${b}/${a}`); return recorded.length === 1; },
    signedUrl: async (path, ttl) => `https://cdn.example/${path}?token=signed&ttl=${ttl}`,
    ...over,
  };
  return { deps, recorded };
}

function req(body: unknown, opts: { token?: string | null; ip?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", "x-real-ip": opts.ip ?? `198.51.100.${++ipCounter % 250}` };
  if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? "good-token-good-token-1234"}`;
  return new Request("https://api.riddlebound.app/api/books/unlock", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
}
const good = { bookId: "s309-b1", assetId: "kcal-0531", submittedAnswer: "Outside" };

beforeEach(() => setRateStoreForTests(null));

describe("POST /api/books/unlock", () => {
  it("unlocks with the right answer, records it and returns a short-lived link", async () => {
    const { deps, recorded } = makeDeps();
    const res = await handleUnlock(req(good), deps);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j).toMatchObject({ ok: true, unlocked: true, firstTime: true, expiresInSeconds: 300 });
    expect(j.contentUrl).toContain("token=signed");
    expect(recorded).toEqual([`${USER}/s309-b1/kcal-0531`]);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("wrong answer: 400, nothing recorded, no link", async () => {
    const { deps, recorded } = makeDeps();
    const res = await handleUnlock(req({ ...good, submittedAnswer: "inside" }), deps);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("incorrect");
    expect(recorded).toEqual([]);
  });

  it("requires sign-in, and never trusts a userId from the body", async () => {
    const { deps } = makeDeps();
    expect((await handleUnlock(req(good, { token: null }), deps)).status).toBe(401);
    expect((await handleUnlock(req(good, { token: "forged-token-forged-1234" }), deps)).status).toBe(401);
    const other = await handleUnlock(req({ ...good, userId: "00000000-0000-0000-0000-0000000000ff" }), deps);
    expect(other.status).toBe(403);
  });

  it("no membership or purchase: 403 before the answer is checked", async () => {
    let looked = false;
    const { deps } = makeDeps({ hasAccess: async () => false, getAsset: async () => { looked = true; return null; } });
    const res = await handleUnlock(req(good), deps);
    expect(res.status).toBe(403);
    expect(looked).toBe(false);
  });

  it("rate limit: the 6th submission in a minute from one IP gets 429, before any database work", async () => {
    let dbCalls = 0;
    const { deps } = makeDeps({ hasAccess: async () => { dbCalls++; return true; } });
    const ip = "203.0.113.9";
    for (let i = 0; i < 5; i++) expect((await handleUnlock(req({ ...good, submittedAnswer: `guess${i}` }, { ip }), deps)).status).toBe(400);
    const sixth = await handleUnlock(req(good, { ip }), deps);
    expect(sixth.status).toBe(429);
    expect(sixth.headers.get("retry-after")).toMatch(/^\d+$/);
    expect((await sixth.json()).message).toMatch(/5 codes in the last minute/);
    expect(dbCalls).toBe(5);
  });

  it("rate limit also applies per user across many IPs", async () => {
    const { deps } = makeDeps({ authenticate: async () => ({ id: "00000000-0000-0000-0000-0000000000b7" }) });
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await handleUnlock(req({ ...good, submittedAnswer: `g${i}` }, { ip: `192.0.2.${i + 1}` }), deps)).status);
    expect(statuses.slice(0, 5).every((s) => s === 400)).toBe(true);
    expect(statuses.slice(5)).toEqual([429, 429]);
  });

  it("rejects malformed input", async () => {
    const { deps } = makeDeps();
    expect((await handleUnlock(req("{not json"), deps)).status).toBe(400);
    expect((await handleUnlock(req({ ...good, bookId: "../etc" }), deps)).status).toBe(400);
    expect((await handleUnlock(req({ ...good, submittedAnswer: "" }), deps)).status).toBe(400);
    expect((await handleUnlock(req({ ...good, submittedAnswer: "x".repeat(201) }), deps)).status).toBe(400);
  });

  it("unknown puzzle: 404", async () => {
    const { deps } = makeDeps();
    expect((await handleUnlock(req({ ...good, assetId: "nope" }), deps)).status).toBe(404);
  });

  it("a failing dependency becomes a clean 500, never a crash or a leak", async () => {
    const { deps } = makeDeps({ signedUrl: async () => { throw new Error("storage down: secret=xyz"); } });
    const res = await handleUnlock(req(good), deps);
    expect(res.status).toBe(500);
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain("secret=xyz");
  });

  it("not configured: 503", async () => {
    expect((await handleUnlock(req(good), null)).status).toBe(503);
  });

  it("a shared-store outage still limits (falls back to local counting)", async () => {
    setRateStoreForTests({ incr: async () => { throw new Error("kv down"); } });
    const { deps } = makeDeps();
    const ip = "203.0.113.77";
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await handleUnlock(req({ ...good, submittedAnswer: `n${i}` }, { ip }), deps)).status);
    expect(statuses.at(-1)).toBe(429);
  });
});
