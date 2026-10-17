/**
 * The free tier: N audits per visitor per day, and a ceiling for everybody
 * together, remembering nobody.
 *
 * A visitor is an HMAC of their IP under a random secret held only in memory and
 * replaced at every UTC midnight, when the counts reset anyway. The buckets cannot
 * be turned back into addresses, and tomorrow's cannot be linked to today's.
 * Nothing here touches the disk; a restart forgives everyone.
 *
 * The global cap is the cost circuit breaker: whatever happens (a botnet, a bug in
 * a client), the box makes at most `globalDaily` fresh audits a day.
 */
import { createHmac, randomBytes } from 'node:crypto'

export const utcDay = (now = Date.now()) => Math.floor(now / 86_400_000)
export const nextResetMs = (now = Date.now()) => (utcDay(now) + 1) * 86_400_000

export type Quota = { limit: number; used: number; remaining: number; resetAt: string; retryAfter: number }

export class DailyQuota {
  private salt = randomBytes(32)
  private day = utcDay()
  private counts = new Map<string, number>()
  private globalUsed = 0

  constructor(
    readonly perVisitor = 10,
    readonly globalDaily = 2_000,
    private readonly now: () => number = Date.now,
  ) {}

  private roll(): void {
    const today = utcDay(this.now())
    if (today !== this.day) {
      this.day = today
      this.salt = randomBytes(32)
      this.counts.clear()
      this.globalUsed = 0
    }
  }

  private key(ip: string): string {
    return createHmac('sha256', this.salt).update(ip).digest('base64url').slice(0, 22)
  }

  /** What this visitor has left today, without spending anything. */
  peek(ip: string): Quota {
    this.roll()
    const used = this.counts.get(this.key(ip)) ?? 0
    const reset = nextResetMs(this.now())
    return { limit: this.perVisitor, used, remaining: Math.max(0, this.perVisitor - used), resetAt: new Date(reset).toISOString(), retryAfter: Math.max(1, Math.ceil((reset - this.now()) / 1000)) }
  }

  /** Spend one audit. `visitor` means this visitor is out; `global` means everyone is. */
  take(ip: string): { ok: true; quota: Quota } | { ok: false; reason: 'visitor' | 'global'; quota: Quota } {
    const quota = this.peek(ip)
    if (quota.remaining <= 0) return { ok: false, reason: 'visitor', quota }
    if (this.globalUsed >= this.globalDaily) return { ok: false, reason: 'global', quota }
    const k = this.key(ip)
    this.counts.set(k, quota.used + 1)
    this.globalUsed++
    if (this.counts.size > 200_000) this.counts.delete(this.counts.keys().next().value!)
    return { ok: true, quota: { ...quota, used: quota.used + 1, remaining: quota.remaining - 1 } }
  }

  /** Give one back (the audit failed before costing anything, e.g. the name does not resolve). */
  refund(ip: string): void {
    this.roll()
    const k = this.key(ip)
    const used = this.counts.get(k) ?? 0
    if (used > 0) this.counts.set(k, used - 1)
    if (this.globalUsed > 0) this.globalUsed--
  }

  stats(): { day: string; globalUsed: number; globalDaily: number; visitors: number } {
    this.roll()
    return { day: new Date(this.day * 86_400_000).toISOString().slice(0, 10), globalUsed: this.globalUsed, globalDaily: this.globalDaily, visitors: this.counts.size }
  }
}

/** At most `max` audits in flight at once, so a burst cannot pile up sockets on the box. */
export class Gate {
  private active = 0
  constructor(readonly max = 8) {}
  tryEnter(): boolean {
    if (this.active >= this.max) return false
    this.active++
    return true
  }
  leave(): void {
    this.active = Math.max(0, this.active - 1)
  }
}
