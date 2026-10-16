import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import { syncEvent, type SyncDb } from "./stripe-sync";

// A stand-in database that mimics the SQL functions' contracts (the real
// functions are tested against Postgres; see README).
function fakeDb(opts: { linked?: boolean } = {}) {
  const calls: [string, Record<string, unknown>][] = [];
  const events = new Map<string, string>();
  let linked = opts.linked ?? true;
  const db: SyncDb = {
    async rpc(fn, args) {
      calls.push([fn, args]);
      switch (fn) {
        case "rb_stripe_event_begin": {
          const s = events.get(args.p_id as string);
          if (!s) { events.set(args.p_id as string, "processing"); return "new"; }
          return s === "processed" || s === "ignored" ? "duplicate" : "retry";
        }
        case "rb_stripe_event_finish": events.set(args.p_id as string, args.p_status as string); return null;
        case "rb_link_customer": linked = true; return "linked";
        case "rb_apply_membership": return linked ? "applied" : "no_user";
        case "rb_grant_book": return linked ? "granted" : "no_user";
        default: throw new Error(`unexpected ${fn}`);
      }
    },
  };
  return { db, calls, events };
}

const now = Math.floor(Date.now() / 1000);
const sub = (over: Partial<Stripe.Subscription> = {}): Stripe.Subscription =>
  ({ id: "sub_1", object: "subscription", customer: "cus_1", status: "active", metadata: { product: "riddlebound" },
     items: { data: [{ current_period_end: now + 30 * 86400 }] }, ...over }) as unknown as Stripe.Subscription;
const evt = (type: string, object: unknown, id = `evt_${Math.random().toString(36).slice(2)}`): Stripe.Event =>
  ({ id, type, created: now, data: { object } }) as unknown as Stripe.Event;

describe("Stripe -> entitlements", () => {
  it("subscription created/updated sets expires_at to the period end", async () => {
    const { db, calls } = fakeDb();
    expect(await syncEvent(db, evt("customer.subscription.created", sub()))).toEqual({ status: 200, result: "processed" });
    const apply = calls.find((c) => c[0] === "rb_apply_membership")![1];
    expect(Date.parse(apply.p_expires_at as string) / 1000).toBe(now + 30 * 86400);
    expect(apply.p_customer).toBe("cus_1");
  });

  it("cancellation (deleted) and terminal statuses revoke immediately", async () => {
    for (const [type, s] of [["customer.subscription.deleted", sub({ status: "canceled" })], ["customer.subscription.updated", sub({ status: "unpaid" })]] as const) {
      const { db, calls } = fakeDb();
      await syncEvent(db, evt(type, s));
      const apply = calls.find((c) => c[0] === "rb_apply_membership")![1];
      expect(Math.abs(Date.parse(apply.p_expires_at as string) - Date.now())).toBeLessThan(5000);
    }
  });

  it("the same event delivered twice is applied once", async () => {
    const { db, calls } = fakeDb();
    const e = evt("customer.subscription.updated", sub(), "evt_dup");
    await syncEvent(db, e);
    expect(await syncEvent(db, e)).toEqual({ status: 200, result: "duplicate" });
    expect(calls.filter((c) => c[0] === "rb_apply_membership")).toHaveLength(1);
  });

  it("a subscription before its checkout link: 500 so Stripe retries, then succeeds", async () => {
    const { db, events } = fakeDb({ linked: false });
    const e = evt("customer.subscription.created", sub(), "evt_early");
    expect((await syncEvent(db, e)).status).toBe(500);
    expect(events.get("evt_early")).toBe("failed");
    await syncEvent(db, evt("checkout.session.completed", { id: "cs_1", mode: "subscription", payment_status: "paid", customer: "cus_1", client_reference_id: "00000000-0000-0000-0000-0000000000a1", metadata: { product: "riddlebound" } }));
    expect(await syncEvent(db, e)).toEqual({ status: 200, result: "processed" });
  });

  it("single-book checkout grants that book, with no expiry", async () => {
    const { db, calls } = fakeDb();
    await syncEvent(db, evt("checkout.session.completed", { id: "cs_book", mode: "payment", payment_status: "paid", customer: "cus_1", client_reference_id: "00000000-0000-0000-0000-0000000000a1", metadata: { product: "riddlebound", purchase_type: "single_book", book_id: "s309-b1" } }));
    expect(calls.find((c) => c[0] === "rb_grant_book")![1]).toMatchObject({ p_book: "s309-b1", p_checkout: "cs_book" });
  });

  it("ignores other products on the same Stripe account (e.g. Quickwell)", async () => {
    const { db, calls } = fakeDb();
    expect((await syncEvent(db, evt("customer.subscription.created", sub({ metadata: { tool: "shield" } })))).result).toBe("ignored");
    expect((await syncEvent(db, evt("checkout.session.completed", { id: "cs_q", mode: "subscription", payment_status: "paid", customer: "cus_9", client_reference_id: null, metadata: { tool: "shield" } }))).result).toBe("ignored");
    expect(calls.some((c) => c[0] === "rb_apply_membership" || c[0] === "rb_link_customer")).toBe(false);
  });

  it("unpaid async checkouts wait for async_payment_succeeded", async () => {
    const { db, calls } = fakeDb();
    await syncEvent(db, evt("checkout.session.completed", { id: "cs_ach", mode: "payment", payment_status: "unpaid", customer: "cus_1", client_reference_id: "00000000-0000-0000-0000-0000000000a1", metadata: { product: "riddlebound", purchase_type: "single_book", book_id: "s309-b1" } }));
    expect(calls.some((c) => c[0] === "rb_grant_book")).toBe(false);
  });
});
