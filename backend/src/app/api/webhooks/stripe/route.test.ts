import { describe, expect, it, vi } from "vitest";
import Stripe from "stripe";

const rpcCalls: string[] = [];
vi.mock("@/lib/supabase", () => ({
  adminClient: () => ({
    rpc: async (fn: string) => {
      rpcCalls.push(fn);
      return { data: fn === "rb_stripe_event_begin" ? "new" : fn === "rb_apply_membership" ? "applied" : null, error: null };
    },
  }),
}));

process.env.STRIPE_SECRET_KEY = "sk_test_fake_for_signature_tests";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_secret_value";
const { POST } = await import("./route");
const stripe = new Stripe("sk_test_x");

function signed(payload: string, secret = "whsec_test_secret_value") {
  return stripe.webhooks.generateTestHeaderString({ payload, secret });
}

describe("POST /api/webhooks/stripe", () => {
  const payload = JSON.stringify({
    id: "evt_sig1", object: "event", type: "customer.subscription.updated", created: Math.floor(Date.now() / 1000),
    data: { object: { id: "sub_1", customer: "cus_1", status: "active", metadata: { product: "riddlebound" }, items: { data: [{ current_period_end: Math.floor(Date.now() / 1000) + 86400 }] } } },
  });

  it("accepts a correctly signed event and applies it", async () => {
    const res = await POST(new Request("https://x/api/webhooks/stripe", { method: "POST", headers: { "stripe-signature": signed(payload) }, body: payload }));
    expect(res.status).toBe(200);
    expect(rpcCalls).toContain("rb_apply_membership");
  });

  it("rejects a bad signature, a wrong secret and a tampered body", async () => {
    const before = rpcCalls.length;
    for (const [sig, body] of [["t=1,v1=deadbeef", payload], [signed(payload, "whsec_other"), payload], [signed(payload), payload.replace("active", "trialing")]]) {
      const res = await POST(new Request("https://x/api/webhooks/stripe", { method: "POST", headers: { "stripe-signature": sig }, body }));
      expect(res.status).toBe(400);
    }
    expect(rpcCalls.length).toBe(before);
  });
});
