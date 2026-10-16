import { beforeEach, describe, expect, it } from "vitest";
import { hashCode } from "./answers";
import { setRateStoreForTests } from "./ratelimit";
import { handleRedeem, type RedeemDeps } from "./redeem";

const PEPPER = "p".repeat(48);
const MEMBER = "00000000-0000-0000-0000-0000000000a1";
const LAPSED = "00000000-0000-0000-0000-0000000000b2";
const JOIN = "https://riddlebound.app/join/";
let ipCounter = 0;

function makeDeps(over: Partial<RedeemDeps> = {}) {
  const recorded: string[] = [];
  const codes = new Map([[hashCode(PEPPER, "GHOST-ZERO"), { book_id: "ghost-freight", asset_id: "dossier-001", encrypted_content_url: "riddlebound-assets/ghost-freight/dossier-001.pdf" }]]);
  const deps: RedeemDeps = {
    pepper: PEPPER,
    urlTtlSeconds: 300,
    joinUrl: JOIN,
    authenticate: async (r) => ({ "Bearer member-token": { id: MEMBER }, "Bearer lapsed-token": { id: LAPSED } } as Record<string, { id: string }>)[r.headers.get("authorization") ?? ""] ?? null,
    findCode: async (h) => codes.get(h) ?? null,
    hasAccess: async (user) => user === MEMBER, // the lapsed user's membership expired
    recordUnlock: async (u, b, a) => { recorded.push(`${u}/${b}/${a}`); return recorded.length === 1; },
    signedUrl: async (path, ttl) => `https://cdn.example/${path}?ttl=${ttl}`,
    ...over,
  };
  return { deps, recorded };
}
const req = (body: unknown, token: string | null = "member-token", ip = `203.0.113.${++ipCounter % 250}`) =>
  new Request("https://api.riddlebound.app/api/codes/redeem", {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": ip, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

beforeEach(() => setRateStoreForTests(null));

describe("POST /api/codes/redeem", () => {
  it("a member with a live code gets the file once, recorded in their history", async () => {
    const { deps, recorded } = makeDeps();
    const res = await handleRedeem(req({ code: "ghost-zero" }), deps);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, unlocked: true, firstTime: true, bookId: "ghost-freight", assetId: "dossier-001" });
    expect(body.contentUrl).toContain("dossier-001.pdf");
    expect(recorded).toEqual([`${MEMBER}/ghost-freight/dossier-001`]);
  });

  it("the right code with an expired membership: 403 with the join link, nothing recorded, no file", async () => {
    const { deps, recorded } = makeDeps();
    const res = await handleRedeem(req({ code: "GHOST-ZERO" }, "lapsed-token"), deps);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, error: "no_access", requiresSubscription: true, joinUrl: JOIN });
    expect(recorded).toEqual([]);
  });

  it("the right code while logged out: 401 with the join link, before any lookup", async () => {
    let looked = false;
    const { deps } = makeDeps({ findCode: async () => { looked = true; return null; } });
    const res = await handleRedeem(req({ code: "GHOST-ZERO" }, null), deps);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "unauthenticated", joinUrl: JOIN });
    expect(looked).toBe(false);
  });

  it("a forged token or a userId in the body changes nothing: identity comes from the verified token", async () => {
    const { deps, recorded } = makeDeps();
    expect((await handleRedeem(req({ code: "GHOST-ZERO", userId: MEMBER }, "forged-token"), deps)).status).toBe(401);
    const res = await handleRedeem(req({ code: "GHOST-ZERO", userId: MEMBER }, "lapsed-token"), deps);
    expect(res.status).toBe(403);
    expect(recorded).toEqual([]);
  });

  it("an unknown or switched-off code: 404, and membership is never consulted", async () => {
    let asked = false;
    const { deps } = makeDeps({ hasAccess: async () => { asked = true; return true; } });
    const res = await handleRedeem(req({ code: "GHOST-NOPE" }), deps);
    expect(res.status).toBe(404);
    expect(asked).toBe(false);
  });

  it("guessing is rate limited: the 6th try in a minute from one IP gets 429 before any lookup", async () => {
    let lookups = 0;
    const { deps } = makeDeps({ findCode: async () => { lookups++; return null; } });
    for (let i = 0; i < 5; i++) expect((await handleRedeem(req({ code: `GUESS-${i}` }, "member-token", "198.51.100.7"), deps)).status).toBe(404);
    const res = await handleRedeem(req({ code: "GUESS-5" }, "member-token", "198.51.100.7"), deps);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
    expect(lookups).toBe(5);
  });

  it("rejects malformed input", async () => {
    const { deps } = makeDeps();
    expect((await handleRedeem(req("{not json"), deps)).status).toBe(400);
    expect((await handleRedeem(req({ code: "" }), deps)).status).toBe(400);
    expect((await handleRedeem(req({ code: "x".repeat(41) }), deps)).status).toBe(400);
  });

  it("a database failure is a clean 500, never a leak", async () => {
    const { deps } = makeDeps({ findCode: async () => { throw new Error("connection refused at 10.0.0.5"); } });
    const res = await handleRedeem(req({ code: "GHOST-ZERO" }), deps);
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("10.0.0.5");
  });

  it("not configured: 503", async () => {
    expect((await handleRedeem(req({ code: "GHOST-ZERO" }), null)).status).toBe(503);
  });

  it("codes are matched by keyed hash, ignoring case, spaces and dashes", () => {
    expect(hashCode(PEPPER, "GHOST-ZERO")).toBe(hashCode(PEPPER, " ghost zero "));
    expect(hashCode(PEPPER, "GHOST-ZERO")).not.toBe(hashCode("q".repeat(48), "GHOST-ZERO"));
  });
});
