/**
 * API keys for trusted callers (another of our services auditing its own lead
 * list, say). A keyed request skips the per-visitor free limit and does not count
 * against the public global cap; instead each key has its own daily cap.
 *
 * Keys come from SEORANK_API_KEYS: comma-separated, each either `name:key` or a
 * bare `key` (named key1, key2, …). Keys are compared in constant time and never
 * logged or echoed; only the name ever leaves this module.
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import { nextResetMs, utcDay, type Quota } from './ratelimit.js'

export type ApiKey = { name: string; digest: Buffer }

const digest = (s: string) => createHash('sha256').update(s).digest()

/** Parse SEORANK_API_KEYS. Keys shorter than 16 characters are ignored: a short key is a typo, not a credential. */
export function parseApiKeys(raw: string | undefined): ApiKey[] {
  const out: ApiKey[] = []
  for (const [i, part] of String(raw ?? '').split(',').entries()) {
    const entry = part.trim()
    if (!entry) continue
    const at = entry.indexOf(':')
    const name = at > 0 ? entry.slice(0, at).trim() : `key${i + 1}`
    const key = at > 0 ? entry.slice(at + 1).trim() : entry
    if (key.length < 16 || !/^[\w.-]{1,64}$/.test(name)) continue
    out.push({ name, digest: digest(key) })
  }
  return out
}

/** The presented key from `Authorization: Bearer <key>` or `X-API-Key: <key>`, or null when neither is sent. */
export function presentedKey(headers: Headers): string | null {
  const auth = headers.get('authorization')
  if (auth) {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(auth)
    if (m) return m[1]!
  }
  const x = headers.get('x-api-key')
  return x && x.trim() ? x.trim() : null
}

/**
 * The name of the key that matches, or null. Every configured key is compared
 * (no early exit) over fixed-length digests, so timing says nothing about which
 * key, or how much of one, matched.
 */
export function matchKey(keys: ApiKey[], presented: string): string | null {
  const d = digest(presented)
  let found: string | null = null
  for (const k of keys) {
    const same = timingSafeEqual(k.digest, d)
    if (same && found === null) found = k.name
  }
  return found
}

/** A daily cap per key name, reset at UTC midnight. In memory, like the free tier. */
export class KeyQuota {
  private day = utcDay()
  private counts = new Map<string, number>()

  constructor(
    readonly perKey = 50_000,
    private readonly now: () => number = Date.now,
  ) {}

  private roll(): void {
    const today = utcDay(this.now())
    if (today !== this.day) {
      this.day = today
      this.counts.clear()
    }
  }

  peek(name: string): Quota {
    this.roll()
    const used = this.counts.get(name) ?? 0
    const reset = nextResetMs(this.now())
    return { limit: this.perKey, used, remaining: Math.max(0, this.perKey - used), resetAt: new Date(reset).toISOString(), retryAfter: Math.max(1, Math.ceil((reset - this.now()) / 1000)) }
  }

  take(name: string): { ok: true; quota: Quota } | { ok: false; quota: Quota } {
    const quota = this.peek(name)
    if (quota.remaining <= 0) return { ok: false, quota }
    this.counts.set(name, quota.used + 1)
    return { ok: true, quota: { ...quota, used: quota.used + 1, remaining: quota.remaining - 1 } }
  }

  /** Per-key usage for /health. Names only; keys are never held here. */
  stats(names: string[]): { name: string; used: number; limit: number }[] {
    this.roll()
    return names.map((name) => ({ name, used: this.counts.get(name) ?? 0, limit: this.perKey }))
  }
}
