// Sliding-window rate limiter (two fixed buckets, weighted), shared through
// Vercel KV / Upstash over REST when configured, in-memory otherwise.
//
// Unlike Loadmark's link limiter, this one FAILS CLOSED-ish: if the shared
// store is unreachable it keeps counting in memory on this instance, so a
// cache outage never becomes an unlimited brute-force window.

export interface CounterStore {
  incr(key: string, bucket: number, windowMs: number): Promise<[current: number, previous: number]>;
}

class MemoryStore implements CounterStore {
  private m = new Map<string, number>();
  async incr(key: string, bucket: number): Promise<[number, number]> {
    const k = `${key}:${bucket}`;
    const n = (this.m.get(k) ?? 0) + 1;
    this.m.delete(k);
    this.m.set(k, n);
    while (this.m.size > 100_000) this.m.delete(this.m.keys().next().value as string);
    return [n, this.m.get(`${key}:${bucket - 1}`) ?? 0];
  }
}

class RestStore implements CounterStore {
  constructor(private url: string, private token: string) {}
  async incr(key: string, bucket: number, windowMs: number): Promise<[number, number]> {
    const cur = `rb:rl:${key}:${bucket}`;
    const res = await fetch(`${this.url}/pipeline`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify([["INCR", cur], ["PEXPIRE", cur, String(windowMs * 2)], ["GET", `rb:rl:${key}:${bucket - 1}`]]),
      signal: AbortSignal.timeout(300),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`kv ${res.status}`);
    const out = (await res.json()) as { result: unknown }[];
    return [Number(out[0]?.result ?? 0), Number(out[2]?.result ?? 0)];
  }
}

let memory = new MemoryStore();
let shared: CounterStore | null | undefined;
function sharedStore(): CounterStore | null {
  if (shared !== undefined) return shared;
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  shared = url && token ? new RestStore(url.replace(/\/$/, ""), token) : null;
  return shared;
}
export function setRateStoreForTests(store: CounterStore | null): void {
  shared = store;
  memory = new MemoryStore(); // fresh counters for each test
}

export type RateResult = { allowed: boolean; count: number; retryAfterSeconds: number };

// Counts one event for key and reports whether it is within `limit` per `windowMs`.
export async function rateLimit(key: string, limit: number, windowMs: number, now = Date.now()): Promise<RateResult> {
  const bucket = Math.floor(now / windowMs);
  let counts: [number, number];
  const store = sharedStore();
  try {
    counts = store ? await store.incr(key, bucket, windowMs) : await memory.incr(key, bucket);
  } catch {
    counts = await memory.incr(key, bucket); // shared store down: keep limiting locally
  }
  const [cur, prev] = counts;
  const elapsed = (now % windowMs) / windowMs;
  const count = cur + prev * (1 - elapsed);
  return {
    allowed: count <= limit,
    count,
    retryAfterSeconds: Math.max(1, Math.ceil((windowMs - (now % windowMs)) / 1000)),
  };
}
