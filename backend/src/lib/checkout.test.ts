import { beforeEach, describe, expect, it } from "vitest";
import { handleCheckout, type CheckoutDeps, type SessionParams } from "./checkout";
import { handleMe, handlePortal, type AccountDeps } from "./account";
import { allowedOrigins, preflight, withCors } from "./cors";
import { setRateStoreForTests } from "./ratelimit";

const NEW = { id: "00000000-0000-0000-0000-0000000000c3", email: "reader@example.com" };
const MEMBER = { id: "00000000-0000-0000-0000-0000000000a1", email: "member@example.com" };
const SITE = "https://riddlebound.app";
const users: Record<string, { id: string; email: string | null }> = { "Bearer new-token": NEW, "Bearer member-token": MEMBER };

function makeDeps(over: Partial<CheckoutDeps> = {}) {
  const sessions: SessionParams[] = [];
  const customers: string[] = [];
  const deps: CheckoutDeps = {
    siteUrl: SITE,
    booksForSale: new Set(["ghost-freight"]),
    authenticate: async (r) => users[r.headers.get("authorization") ?? ""] ?? null,
    isMember: async (id) => id === MEMBER.id,
    hasBook: async () => false,
    customerFor: async (u) => { customers.push(u.id); return "cus_Test123"; },
    priceFor: async (k) => ({ riddlebound__member__month: "price_month", riddlebound__member__year: "price_year", riddlebound__book__once: "price_book" } as Record<string, string>)[k] ?? null,
    createSession: async (p) => { sessions.push(p); return "https://checkout.stripe.com/c/pay/cs_test"; },
    ...over,
  };
  return { deps, sessions, customers };
}
const req = (body: unknown, token: string | null = "new-token") =>
  new Request("https://riddlebound.vercel.app/api/checkout", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

beforeEach(() => setRateStoreForTests(null));

describe("POST /api/checkout", () => {
  it("monthly: a subscription checkout tagged for the webhook, member from the token only", async () => {
    const { deps, sessions, customers } = makeDeps();
    const res = await handleCheckout(req({ plan: "month", userId: MEMBER.id }), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, url: "https://checkout.stripe.com/c/pay/cs_test" });
    expect(customers).toEqual([NEW.id]); // the body's userId is ignored
    expect(sessions[0]).toEqual({
      mode: "subscription",
      price: "price_month",
      customer: "cus_Test123",
      clientReferenceId: NEW.id,
      metadata: { product: "riddlebound", plan: "month" },
      subscriptionMetadata: { product: "riddlebound", plan: "month" },
      successUrl: `${SITE}/account/?welcome=1`,
      cancelUrl: `${SITE}/join/?canceled=1`,
    });
  });

  it("yearly uses the yearly price", async () => {
    const { deps, sessions } = makeDeps();
    expect((await handleCheckout(req({ plan: "year" }), deps)).status).toBe(200);
    expect(sessions[0].price).toBe("price_year");
  });

  it("single book: a one-time payment carrying the book for rb_grant_book", async () => {
    const { deps, sessions } = makeDeps();
    expect((await handleCheckout(req({ plan: "book", bookId: "ghost-freight" }), deps)).status).toBe(200);
    expect(sessions[0]).toMatchObject({
      mode: "payment",
      price: "price_book",
      subscriptionMetadata: null,
      metadata: { product: "riddlebound", plan: "book", purchase_type: "single_book", book_id: "ghost-freight" },
    });
  });

  it("logged out: 401, nothing created", async () => {
    const { deps, sessions, customers } = makeDeps();
    expect((await handleCheckout(req({ plan: "month" }, null), deps)).status).toBe(401);
    expect(sessions.length + customers.length).toBe(0);
  });

  it("bad input: 400", async () => {
    const { deps } = makeDeps();
    for (const body of ["{not json", { plan: "weekly" }, { plan: "book" }, { plan: "book", bookId: "../etc" }]) {
      expect((await handleCheckout(req(body), deps)).status).toBe(400);
    }
  });

  it("a book that isn't on sale: 404", async () => {
    const { deps } = makeDeps();
    const res = await handleCheckout(req({ plan: "book", bookId: "dead-mans-switch" }), deps);
    expect(res.status).toBe(404);
  });

  it("an active member can't buy a second membership or a book: 409 with the account page", async () => {
    const { deps, sessions } = makeDeps();
    for (const body of [{ plan: "month" }, { plan: "book", bookId: "ghost-freight" }]) {
      const res = await handleCheckout(req(body, "member-token"), deps);
      expect(res.status).toBe(409);
      expect((await res.json()).accountUrl).toBe(`${SITE}/account/`);
    }
    expect(sessions).toEqual([]);
  });

  it("a book already owned: 409", async () => {
    const { deps } = makeDeps({ hasBook: async () => true });
    const res = await handleCheckout(req({ plan: "book", bookId: "ghost-freight" }), deps);
    expect((await res.json()).error).toBe("already_owned");
  });

  it("a customer already linked to someone else: 409, no checkout", async () => {
    const { deps, sessions } = makeDeps({ customerFor: async () => null });
    const res = await handleCheckout(req({ plan: "month" }), deps);
    expect(res.status).toBe(409);
    expect(sessions).toEqual([]);
  });

  it("a missing price or Stripe failure never leaks details", async () => {
    let { deps } = makeDeps({ priceFor: async () => null });
    expect((await handleCheckout(req({ plan: "month" }), deps)).status).toBe(503);
    ({ deps } = makeDeps({ createSession: async () => { throw new Error("sk_live_secret exploded"); } }));
    const res = await handleCheckout(req({ plan: "month" }), deps);
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("sk_live");
  });

  it("11th checkout in a minute: 429", async () => {
    const { deps } = makeDeps();
    for (let i = 0; i < 10; i++) expect((await handleCheckout(req({ plan: "month" }), deps)).status).toBe(200);
    expect((await handleCheckout(req({ plan: "month" }), deps)).status).toBe(429);
  });

  it("not configured: 503", async () => {
    expect((await handleCheckout(req({ plan: "month" }), null)).status).toBe(503);
  });
});

function accountDeps(over: Partial<AccountDeps> = {}): AccountDeps {
  return {
    siteUrl: SITE,
    authenticate: async (r) => users[r.headers.get("authorization") ?? ""] ?? null,
    entitlements: async (id) => (id === MEMBER.id
      ? [
          { type: "membership_active", book_id: null, expires_at: "2026-11-16T00:00:00Z" },
          { type: "single_book_purchase", book_id: "ghost-freight", expires_at: null },
        ]
      : [{ type: "membership_active", book_id: null, expires_at: "2026-09-01T00:00:00Z" }]),
    customerId: async (id) => (id === MEMBER.id ? "cus_Member" : null),
    portalUrl: async (c, back) => `https://billing.stripe.com/p/session/${c}?return=${back}`,
    ...over,
  };
}
const get = (token: string | null) => new Request("https://riddlebound.vercel.app/api/me", { headers: token ? { authorization: `Bearer ${token}` } : {} });
const NOW = Date.parse("2026-10-16T12:00:00Z");

describe("GET /api/me and POST /api/billing/portal", () => {
  it("a member sees their membership end date and books", async () => {
    const body = await (await handleMe(get("member-token"), accountDeps(), NOW)).json();
    expect(body).toEqual({ ok: true, email: MEMBER.email, member: true, memberUntil: "2026-11-16T00:00:00Z", books: ["ghost-freight"], billing: true });
  });

  it("a lapsed membership reads as not a member", async () => {
    const body = await (await handleMe(get("new-token"), accountDeps(), NOW)).json();
    expect(body.member).toBe(false);
    expect(body.billing).toBe(false);
  });

  it("logged out: 401 on both", async () => {
    expect((await handleMe(get(null), accountDeps(), NOW)).status).toBe(401);
    expect((await handlePortal(get(null), accountDeps())).status).toBe(401);
  });

  it("portal: link back to the account page; 404 without a billing account", async () => {
    const ok = await (await handlePortal(get("member-token"), accountDeps())).json();
    expect(ok.url).toBe(`https://billing.stripe.com/p/session/cus_Member?return=${SITE}/account/`);
    expect((await handlePortal(get("new-token"), accountDeps())).status).toBe(404);
  });
});

describe("CORS", () => {
  const from = (origin: string | null) => new Request("https://riddlebound.vercel.app/api/checkout", { method: "OPTIONS", headers: origin ? { origin } : {} });

  it("only the Riddlebound site gets CORS headers", () => {
    expect(preflight(from("https://riddlebound.app")).headers.get("access-control-allow-origin")).toBe("https://riddlebound.app");
    expect(preflight(from("https://evil.example")).headers.get("access-control-allow-origin")).toBeNull();
    expect(preflight(from(null)).headers.get("access-control-allow-origin")).toBeNull();
  });

  it("keeps the status and body and adds the headers", async () => {
    const res = withCors(from("https://www.riddlebound.app"), Response.json({ ok: false }, { status: 401 }));
    expect(res.status).toBe(401);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://www.riddlebound.app");
    expect(await res.json()).toEqual({ ok: false });
  });

  it("origins can be set by env", () => {
    expect([...allowedOrigins({ RIDDLEBOUND_SITE_ORIGINS: "https://a.example/, https://b.example" })]).toEqual(["https://a.example", "https://b.example"]);
  });
});
