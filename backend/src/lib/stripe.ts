import "server-only";
import Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AccountDeps } from "./account";
import type { CheckoutDeps } from "./checkout";
import { PRODUCT } from "./stripe-sync";
import { userFromRequest } from "./supabase";

// STRIPE_SECRET_KEY is a RESTRICTED key (rk_live_...): Checkout Sessions, Customers and Customer
// portal write; Prices, Products and Subscriptions read. It cannot pay out, transfer or refund.
let stripe: Stripe | null = null;
export function stripeClient(): Stripe | null {
  if (stripe) return stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  stripe = key ? new Stripe(key, { appInfo: { name: "riddlebound-backend", version: "1.1.0" } }) : null;
  return stripe;
}

export const siteUrl = (): string => (process.env.RIDDLEBOUND_SITE_URL || "https://riddlebound.app").replace(/\/$/, "");

async function customerIdOf(db: SupabaseClient, userId: string): Promise<string | null> {
  const { data, error } = await db.from("profiles").select("stripe_customer_id").eq("id", userId).maybeSingle();
  if (error) throw new Error(`profile lookup failed: ${error.message}`);
  return (data?.stripe_customer_id as string | null) ?? null;
}

async function liveEntitlements(db: SupabaseClient, userId: string) {
  const { data, error } = await db.from("entitlements").select("type, book_id, expires_at").eq("user_id", userId);
  if (error) throw new Error(`entitlement lookup failed: ${error.message}`);
  return (data ?? []) as { type: string; book_id: string | null; expires_at: string | null }[];
}

const prices = new Map<string, { id: string | null; at: number }>();

export function checkoutDeps(db: SupabaseClient | null): CheckoutDeps | null {
  const client = stripeClient();
  if (!db || !client) return null;
  return {
    siteUrl: siteUrl(),
    booksForSale: new Set((process.env.RIDDLEBOUND_BOOKS_FOR_SALE ?? "").split(",").map((s) => s.trim()).filter(Boolean)),
    authenticate: (request) => userFromRequest(request, db),
    async isMember(userId) {
      const now = Date.now();
      return (await liveEntitlements(db, userId)).some((r) => r.type === "membership_active" && (r.expires_at === null || Date.parse(r.expires_at) > now));
    },
    async hasBook(userId, bookId) {
      const { data, error } = await db.rpc("rb_has_book_access", { p_user: userId, p_book: bookId });
      if (error) throw new Error(`access check failed: ${error.message}`);
      return data === true;
    },
    async customerFor(user) {
      const existing = await customerIdOf(db, user.id);
      if (existing) return existing;
      // Same idempotency key for the same member, so a double click makes one customer, not two.
      const customer = await client.customers.create(
        { ...(user.email ? { email: user.email } : {}), metadata: { product: PRODUCT, member: user.id } },
        { idempotencyKey: `riddlebound-customer-${user.id}` },
      );
      const { data, error } = await db.rpc("rb_link_customer", { p_user: user.id, p_customer: customer.id });
      if (error) throw new Error(`customer link failed: ${error.message}`);
      if (data === "linked") return customer.id;
      if (data === "no_user") throw new Error("member has no profile");
      return null;
    },
    async priceFor(lookupKey) {
      const hit = prices.get(lookupKey);
      if (hit && Date.now() - hit.at < 10 * 60_000) return hit.id;
      const list = await client.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
      const id = list.data[0]?.id ?? null;
      prices.set(lookupKey, { id, at: Date.now() });
      return id;
    },
    async createSession(p) {
      const session = await client.checkout.sessions.create({
        mode: p.mode,
        line_items: [{ price: p.price, quantity: 1 }],
        customer: p.customer,
        client_reference_id: p.clientReferenceId,
        metadata: p.metadata,
        ...(p.subscriptionMetadata ? { subscription_data: { metadata: p.subscriptionMetadata } } : { payment_intent_data: { metadata: p.metadata } }),
        success_url: p.successUrl,
        cancel_url: p.cancelUrl,
      });
      if (!session.url) throw new Error("checkout session has no url");
      return session.url;
    },
  };
}

export function accountDeps(db: SupabaseClient | null): AccountDeps | null {
  const client = stripeClient();
  if (!db || !client) return null;
  return {
    siteUrl: siteUrl(),
    authenticate: (request) => userFromRequest(request, db),
    entitlements: (userId) => liveEntitlements(db, userId),
    customerId: (userId) => customerIdOf(db, userId),
    async portalUrl(customer, returnUrl) {
      const session = await client.billingPortal.sessions.create({ customer, return_url: returnUrl });
      return session.url;
    },
  };
}
