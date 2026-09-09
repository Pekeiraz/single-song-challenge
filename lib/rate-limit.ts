type Bucket = { count: number; resetAt: number };

type RateLimitStatsEntry = { allowed: number; denied: number; lastDeniedAt: number | null; lastAllowedAt: number | null };

const buckets = new Map<string, Bucket>();
const hits = new Map<string, RateLimitStatsEntry>();

function groupKey(key: string) {
  const idx = key.indexOf(":");
  return idx === -1 ? key : key.slice(0, idx);
}

function recordHit(key: string, allowed: boolean, now: number) {
  const group = groupKey(key);
  const entry = hits.get(group) ?? { allowed: 0, denied: 0, lastDeniedAt: null, lastAllowedAt: null };
  if (allowed) {
    entry.allowed++;
    entry.lastAllowedAt = now;
  } else {
    entry.denied++;
    entry.lastDeniedAt = now;
  }
  hits.set(group, entry);
}

export function getRateLimitStats(): Record<string, RateLimitStatsEntry> {
  return Object.fromEntries(hits);
}

export function resetRateLimitStats() {
  hits.clear();
}

export function clientAddress(request: Request) {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? request.headers.get("x-real-ip")
    ?? "unknown";
}

export function rateLimit(key: string, limit: number, windowMs: number) {
  const now = Date.now();
  const current = buckets.get(key);
  if (!current || current.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    recordHit(key, true, now);
    return { allowed: true, retryAfterSeconds: 0 };
  }
  current.count++;
  if (current.count <= limit) {
    recordHit(key, true, now);
    return { allowed: true, retryAfterSeconds: 0 };
  }
  recordHit(key, false, now);
  if (process.env.NODE_ENV !== "test") console.warn(`[rate-limit] denied group=${groupKey(key)} count=${current.count} limit=${limit}`);
  return { allowed: false, retryAfterSeconds: Math.ceil((current.resetAt - now) / 1000) };
}