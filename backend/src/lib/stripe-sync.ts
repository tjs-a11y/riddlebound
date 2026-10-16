import type Stripe from "stripe";
import { log } from "./http";

// Turns verified Stripe events into Riddlebound entitlements, through the
// database functions in supabase/migrations/0001 (all idempotent).
//
// Only Riddlebound's own objects are acted on: the Stripe account also bills
// other products, so every checkout and subscription for Riddlebound must
// carry metadata.product = "riddlebound" (set when the checkout is created).
// Anything else is recorded as "ignored".

export const PRODUCT = "riddlebound";
const BOOK_RE = /^[a-z0-9-]{1,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Statuses that keep reading access until the end of the paid period.
// past_due: Stripe is still retrying the card; the member keeps access until
// the period ends or Stripe gives up (then the status moves on and access stops).
const KEEPS_ACCESS = new Set<Stripe.Subscription.Status>(["active", "trialing", "past_due"]);

export interface SyncDb {
  rpc(fn: string, args: Record<string, unknown>): Promise<unknown>;
}

// Thrown when the event can't be applied YET (e.g. the subscription arrived
// before the checkout that links the customer). The route answers 500 and
// Stripe retries with backoff for up to 3 days.
export class RetryLater extends Error {}

export type Outcome = "processed" | "ignored";

const customerId = (c: string | { id: string } | null | undefined): string | null =>
  typeof c === "string" ? c : c?.id ?? null;

export function periodEnd(sub: Stripe.Subscription): number {
  const item = sub.items?.data?.[0] as (Stripe.SubscriptionItem & { current_period_end?: number }) | undefined;
  const legacy = (sub as unknown as { current_period_end?: number }).current_period_end;
  return Number(item?.current_period_end ?? legacy ?? 0);
}

async function applySubscription(db: SyncDb, sub: Stripe.Subscription, created: number, deleted: boolean): Promise<Outcome> {
  if (sub.metadata?.product !== PRODUCT) return "ignored";
  const customer = customerId(sub.customer);
  if (!customer) return "ignored";
  const end = periodEnd(sub);
  const keeps = !deleted && KEEPS_ACCESS.has(sub.status) && end * 1000 > Date.now();
  const expiresAt = keeps ? new Date(end * 1000).toISOString() : new Date().toISOString();
  const result = await db.rpc("rb_apply_membership", {
    p_customer: customer,
    p_subscription: sub.id,
    p_expires_at: expiresAt,
    p_event_created: created,
  });
  if (result === "no_user") throw new RetryLater(`customer ${customer} not linked to a member yet`);
  log("stripe_membership", { subscription: sub.id, status: sub.status, deleted, expiresAt, result });
  return "processed";
}

async function applyCheckout(db: SyncDb, session: Stripe.Checkout.Session, created: number): Promise<Outcome> {
  if (session.metadata?.product !== PRODUCT) return "ignored";
  if (session.payment_status === "unpaid") return "ignored"; // delayed methods: wait for async_payment_succeeded
  const customer = customerId(session.customer);
  const userId = session.client_reference_id;
  if (!customer || !userId || !UUID_RE.test(userId)) {
    log("stripe_checkout_unlinkable", { session: session.id, hasCustomer: !!customer, hasUser: !!userId });
    return "ignored";
  }
  const link = await db.rpc("rb_link_customer", { p_user: userId, p_customer: customer });
  if (link === "no_user") throw new RetryLater(`member ${userId} has no profile yet`);
  if (link === "conflict") {
    log("stripe_customer_conflict", { session: session.id, customer });
    return "ignored"; // needs a human: the customer belongs to another member
  }
  if (session.mode === "payment" && session.metadata?.purchase_type === "single_book") {
    const book = session.metadata?.book_id ?? "";
    if (!BOOK_RE.test(book) || session.payment_status !== "paid") return "ignored";
    const granted = await db.rpc("rb_grant_book", { p_customer: customer, p_book: book, p_checkout: session.id, p_event_created: created });
    log("stripe_book_granted", { session: session.id, book, result: granted });
  }
  return "processed";
}

export async function applyEvent(db: SyncDb, event: Stripe.Event): Promise<Outcome> {
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      return applyCheckout(db, event.data.object, event.created);
    case "customer.subscription.created":
    case "customer.subscription.updated":
      return applySubscription(db, event.data.object, event.created, false);
    case "customer.subscription.deleted":
      return applySubscription(db, event.data.object, event.created, true);
    default:
      return "ignored";
  }
}

// Full webhook flow after the signature is verified: idempotency, apply, record.
export async function syncEvent(db: SyncDb, event: Stripe.Event): Promise<{ status: number; result: string }> {
  const started = await db.rpc("rb_stripe_event_begin", { p_id: event.id, p_type: event.type, p_created: event.created });
  if (started === "duplicate") {
    log("stripe_event", { id: event.id, type: event.type, result: "duplicate" });
    return { status: 200, result: "duplicate" };
  }
  try {
    const outcome = await applyEvent(db, event);
    await db.rpc("rb_stripe_event_finish", { p_id: event.id, p_status: outcome, p_error: null });
    log("stripe_event", { id: event.id, type: event.type, result: outcome, attempt: started });
    return { status: 200, result: outcome };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.rpc("rb_stripe_event_finish", { p_id: event.id, p_status: "failed", p_error: message }).catch(() => undefined);
    log("stripe_event", { id: event.id, type: event.type, result: "failed", retry: error instanceof RetryLater, error: message });
    return { status: 500, result: "failed" };
  }
}
