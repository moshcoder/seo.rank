/**
 * The seo.rank web server: pages and the JSON API.
 *
 * Nothing here writes a log line about a request, and no URL anyone audits is
 * logged. Errors are reported without the URL attached.
 */
import { Hono, type Context } from 'hono'
import { startPitFooterRefresh } from './pit-footer.js'
import { startRingFooterRefresh } from './ring-footer.js'
import { RING_PLACEHOLDER, ringBar, startRingRefresh, visitorOnMoshpit } from './ring.js'
import { assertFetchable, FetchRefused } from './fetch.js'
import { audit as runAudit, AuditCache, AuditError, normalizeUrl, type Audit, type AuditOptions } from './audit.js'
import { aboutPage, errorPage, homePage, messagePage, resultsPage, SITE } from './html.js'
import { DailyQuota, Gate, type Quota } from './ratelimit.js'
import { KeyQuota, matchKey, parseApiKeys, presentedKey, type ApiKey } from './keys.js'

export { VERSION } from './version.js'
import { VERSION } from './version.js'

export type Deps = {
  quota?: DailyQuota
  cache?: AuditCache
  gate?: Gate
  /** Tests swap the network; production uses the real one. */
  auditOptions?: AuditOptions
  publicDir?: string
  /** pit.world's ownership token for the seo.rank listing; rendered as <meta name="pit-verify">. */
  pitVerify?: string
  /** Trusted callers (SEORANK_API_KEYS). */
  apiKeys?: ApiKey[]
  keyQuota?: KeyQuota
  /** Concurrency for keyed calls, separate from the public gate so neither starves the other. */
  keyGate?: Gate
}

/** Who is asking: an anonymous visitor (by IP) or a trusted caller (by key name). */
type Caller = { kind: 'visitor'; ip: string } | { kind: 'key'; name: string }

/** The visitor's address arrives as a binding from serve() (or a test), never from a header the visitor controls. */
type Env = { Bindings: { ip?: string } }

const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': "default-src 'none'; script-src https://crawlproof.com; connect-src https://crawlproof.com; frame-src https://crawlproof.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://built.indie.pit.world https://pwamart.com; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'permissions-policy': 'interest-cohort=(), browsing-topics=(), camera=(), microphone=(), geolocation=()',
  'cross-origin-opener-policy': 'same-origin',
  // No HSTS: seo.rank is a Moshpit name, outside the public DNS, and a stale HSTS
  // entry for it is not something a visitor can easily clear (see the nginx vhost).
}

type Outcome =
  | { kind: 'ok'; audit: Audit; cached: boolean; quota: Quota }
  | { kind: 'invalid'; message: string; quota: Quota }
  | { kind: 'refused'; message: string; quota: Quota }
  | { kind: 'failed'; message: string; quota: Quota }
  | { kind: 'limited'; quota: Quota }
  | { kind: 'capped'; quota: Quota }
  | { kind: 'busy'; quota: Quota }

export function createApp(deps: Deps = {}) {
  const quota = deps.quota ?? new DailyQuota(Number(process.env.SEORANK_DAILY_LIMIT ?? 10), Number(process.env.SEORANK_GLOBAL_DAILY_CAP ?? 2000))
  const cache = deps.cache ?? new AuditCache()
  const gate = deps.gate ?? new Gate(Number(process.env.SEORANK_CONCURRENCY ?? 8))
  const options = deps.auditOptions ?? {}
  const apiKeys = deps.apiKeys ?? parseApiKeys(process.env.SEORANK_API_KEYS)
  const keyQuota = deps.keyQuota ?? new KeyQuota(Number(process.env.SEORANK_KEY_DAILY_LIMIT ?? 50_000))
  const keyGate = deps.keyGate ?? new Gate(Number(process.env.SEORANK_KEY_CONCURRENCY ?? 4))
  const inflight = new Map<string, Promise<Audit>>()
  const app = new Hono<Env>()

  app.use('*', async (c, next) => {
    await next()
    // The Moshpit ring bar is drawn per request: direct links for a visitor on Moshpit DNS, gateway links otherwise.
    if (c.res.headers.get('content-type')?.startsWith('text/html')) {
      const html = await c.res.text()
      const bar = ringBar('seo.rank', visitorOnMoshpit('seo.rank', c.req.header('host'), c.req.header('x-moshpit-name')))
      c.res = new Response(html.replace(RING_PLACEHOLDER, bar), c.res)
    }
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) c.header(name, value)
    // Nothing on seo.rank sets a cookie, and nothing ever will by accident.
    c.res.headers.delete('set-cookie')
  })

  const ipOf = (c: Context<Env>) => c.env?.ip || 'unknown'

  /** The one path every surface takes: cache, validate, charge, audit. */
  async function perform(caller: Caller, raw: string): Promise<Outcome> {
    const keyed = caller.kind === 'key'
    const peek = () => (caller.kind === 'key' ? keyQuota.peek(caller.name) : quota.peek(caller.ip))
    const url = normalizeUrl(raw)
    if (!url) return { kind: 'invalid', message: 'Enter a website address, like example.com.', quota: peek() }
    const hit = cache.get(url)
    if (hit) return { kind: 'ok', audit: hit, cached: true, quota: peek() }
    // Validation costs nothing (a DNS lookup), so it happens before an audit is charged.
    try {
      await assertFetchable(url, options.resolve)
    } catch (error) {
      return { kind: 'refused', message: error instanceof FetchRefused ? error.message : 'That URL cannot be audited.', quota: peek() }
    }
    const pending = inflight.get(url)
    if (pending) {
      try {
        return { kind: 'ok', audit: await pending, cached: true, quota: peek() }
      } catch (error) {
        return { kind: 'failed', message: error instanceof AuditError ? error.message : 'The audit failed.', quota: peek() }
      }
    }
    const g = keyed ? keyGate : gate
    if (!g.tryEnter()) return { kind: 'busy', quota: peek() }
    try {
      const taken = caller.kind === 'key' ? keyQuota.take(caller.name) : quota.take(caller.ip)
      if (!taken.ok) return { kind: 'reason' in taken && taken.reason === 'global' ? 'capped' : 'limited', quota: taken.quota }
      const job = runAudit(url, options)
      inflight.set(url, job)
      try {
        const result = await job
        cache.set(url, result)
        if (result.url !== url) cache.set(result.url, result)
        return { kind: 'ok', audit: result, cached: false, quota: taken.quota }
      } catch (error) {
        return { kind: 'failed', message: error instanceof AuditError ? error.message : 'The audit failed.', quota: taken.quota }
      } finally {
        inflight.delete(url)
      }
    } finally {
      g.leave()
    }
  }

  const rateHeaders = (c: Context<Env>, q: Quota) => {
    c.header('x-ratelimit-limit', String(q.limit))
    c.header('x-ratelimit-remaining', String(q.remaining))
    c.header('x-ratelimit-reset', q.resetAt)
  }

  app.get('/', (c) => c.html(homePage(quota.peek(ipOf(c)), deps.pitVerify)))
  app.get('/about', (c) => c.html(aboutPage()))
  app.get('/health', (c) => c.json({ ok: true, version: VERSION, today: quota.stats(), keyed: keyQuota.stats(apiKeys.map((k) => k.name)) }, 200, { 'cache-control': 'no-store' }))
  app.get('/robots.txt', (c) => c.body(`User-agent: *\nDisallow: /audit\nDisallow: /api/\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`, 200, { 'content-type': 'text/plain; charset=utf-8' }))
  app.get('/sitemap.xml', (c) =>
    c.body(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['/', '/about'].map((p) => `<url><loc>${SITE}${p}</loc></url>`).join('')}</urlset>`, 200, { 'content-type': 'application/xml; charset=utf-8' }),
  )

  app.get('/audit', async (c) => {
    const raw = (c.req.query('url') ?? '').trim()
    if (!raw) return c.redirect('/', 302)
    c.header('cache-control', 'no-store')
    const r = await perform({ kind: 'visitor', ip: ipOf(c) }, raw)
    rateHeaders(c, r.quota)
    switch (r.kind) {
      case 'ok':
        return c.html(resultsPage({ audit: r.audit, quota: r.quota, cached: r.cached }))
      case 'invalid':
      case 'refused':
        return c.html(messagePage({ title: 'Cannot audit that', message: r.message, url: raw, quota: r.quota }), 400)
      case 'failed':
        return c.html(messagePage({ title: 'The audit failed', message: r.message, url: raw, quota: r.quota }), 422)
      case 'limited':
        c.header('retry-after', String(r.quota.retryAfter))
        return c.html(messagePage({ title: 'That is all the free audits for today', message: `You have used your ${r.quota.limit} free audits. They come back at midnight UTC.`, url: raw, quota: r.quota, status: 'limited' }), 429)
      case 'capped':
        c.header('retry-after', String(r.quota.retryAfter))
        return c.html(messagePage({ title: 'seo.rank is resting', message: 'The site has done all the free audits it can afford today. Back at midnight UTC, or run it yourself with no limit.', url: raw, quota: r.quota, status: 'limited' }), 503)
      case 'busy':
        c.header('retry-after', '10')
        return c.html(messagePage({ title: 'Busy for a moment', message: 'Lots of audits running right now. Try again in a few seconds; this did not use one of yours.', url: raw, quota: r.quota }), 503)
    }
  })

  // --- JSON API ---------------------------------------------------------------
  app.use('/api/*', async (c, next) => {
    await next()
    c.header('access-control-allow-origin', '*')
    c.header('cache-control', 'no-store')
  })

  /**
   * The caller for an API request. A request that presents a key must present a
   * valid one: a wrong key is a 401, never a silent fall back to the free tier.
   */
  const callerOf = (c: Context<Env>): Caller | 'bad-key' => {
    const presented = presentedKey(c.req.raw.headers)
    if (presented === null) return { kind: 'visitor', ip: ipOf(c) }
    const name = apiKeys.length ? matchKey(apiKeys, presented) : null
    return name ? { kind: 'key', name } : 'bad-key'
  }

  const apiAudit = async (c: Context<Env>, raw: string, opts: { fields?: string; top?: string } = {}) => {
    const caller = callerOf(c)
    if (caller === 'bad-key') return c.json({ error: 'Invalid API key.' }, 401, { 'www-authenticate': 'Bearer' })
    if (!raw.trim()) return c.json({ error: 'url is required' }, 400)
    const r = await perform(caller, raw)
    rateHeaders(c, r.quota)
    const q = { limit: r.quota.limit, remaining: r.quota.remaining, resetAt: r.quota.resetAt }
    switch (r.kind) {
      case 'ok':
        if (opts.fields === 'summary') return c.json({ ...summarize(r.audit, Number(opts.top ?? 5)), cached: r.cached, quota: q })
        return c.json({ ...r.audit, cached: r.cached, quota: q })
      case 'invalid':
      case 'refused':
        return c.json({ error: r.message, quota: q }, 400)
      case 'failed':
        return c.json({ error: r.message, quota: q }, 422)
      case 'limited':
        c.header('retry-after', String(r.quota.retryAfter))
        if (caller.kind === 'key') return c.json({ error: `API key daily limit reached: ${r.quota.limit} audits. Resets at ${r.quota.resetAt}.`, quota: q }, 429)
        return c.json({ error: `Free limit reached: ${r.quota.limit} audits per day. Resets at ${r.quota.resetAt}. Run it yourself with no limit: bunx seorank audit --local <url>`, quota: q }, 429)
      case 'capped':
        c.header('retry-after', String(r.quota.retryAfter))
        return c.json({ error: 'seo.rank has reached its daily audit cap. Try again after midnight UTC, or run it yourself: bunx seorank audit --local <url>', quota: q }, 503)
      case 'busy':
        c.header('retry-after', '10')
        return c.json({ error: 'Busy; try again in a few seconds.', quota: q }, 503)
    }
  }

  const auditOpts = (c: Context<Env>, body: { fields?: unknown; top?: unknown } = {}) => {
    const fields = c.req.query('fields') ?? (typeof body.fields === 'string' ? body.fields : undefined)
    const top = c.req.query('top') ?? (body.top !== undefined ? String(body.top) : undefined)
    return { ...(fields ? { fields } : {}), ...(top ? { top } : {}) }
  }
  app.get('/api/audit', (c) => apiAudit(c, c.req.query('url') ?? '', auditOpts(c)))
  app.post('/api/audit', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { url?: unknown; fields?: unknown; top?: unknown }
    return apiAudit(c, typeof body.url === 'string' ? body.url : '', auditOpts(c, body))
  })
  app.get('/api/quota', (c) => {
    const caller = callerOf(c)
    if (caller === 'bad-key') return c.json({ error: 'Invalid API key.' }, 401, { 'www-authenticate': 'Bearer' })
    const q = caller.kind === 'key' ? keyQuota.peek(caller.name) : quota.peek(caller.ip)
    rateHeaders(c, q)
    return c.json({ limit: q.limit, used: q.used, remaining: q.remaining, resetAt: q.resetAt })
  })

  // --- static -------------------------------------------------------------------
  const dir = deps.publicDir ?? new URL('../public/', import.meta.url).pathname
  const TYPES: Record<string, string> = { css: 'text/css; charset=utf-8', svg: 'image/svg+xml', png: 'image/png' }
  app.get('/:file{[a-z0-9-]+\\.(css|svg|png)}', async (c) => {
    const file = Bun.file(`${dir}${c.req.param('file')}`)
    if (!(await file.exists())) return c.notFound()
    const ext = c.req.param('file').split('.').pop()!
    return c.body(await file.arrayBuffer(), 200, { 'content-type': TYPES[ext]!, 'cache-control': 'public, max-age=86400' })
  })

  app.notFound((c) =>
    c.req.path.startsWith('/api/') ? c.json({ error: 'not found' }, 404) : c.html(messagePage({ title: 'Page not found', message: 'That page does not exist. Audit something instead.' }), 404),
  )
  app.onError((_error, c) => (c.req.path.startsWith('/api/') ? c.json({ error: 'Something went wrong.' }, 500) : c.html(errorPage(), 500)))
  return app
}

/** The small answer for batch callers: score, grade, the top fixes and when it was checked. */
export function summarize(audit: Audit, top = 5) {
  const n = Number.isFinite(top) ? Math.min(25, Math.max(0, Math.floor(top))) : 5
  return {
    url: audit.url,
    finalUrl: audit.finalUrl,
    status: audit.status,
    score: audit.score,
    grade: audit.grade,
    summary: audit.summary,
    fixes: audit.fixes.slice(0, n),
    checkedAt: audit.fetchedAt,
  }
}

export function serve(options: { port?: number; hostname?: string } = {}) {
  const env = process.env
  const app = createApp({ ...(env.PIT_VERIFY ? { pitVerify: env.PIT_VERIFY } : {}) })
  const trustProxy = (env.SEORANK_TRUST_PROXY ?? '1') === '1'
  startRingRefresh()
  startRingFooterRefresh()
  startPitFooterRefresh('seo.rank')
  return Bun.serve({
    port: options.port ?? Number(env.PORT ?? 8790),
    hostname: options.hostname ?? env.HOST ?? '127.0.0.1',
    // An audit can take ~20 s (page, robots.txt, sitemap, http check).
    idleTimeout: 60,
    fetch(request, srv) {
      // Behind nginx on loopback the peer is always 127.0.0.1; nginx passes the visitor in X-Real-IP.
      const peer = srv.requestIP(request)?.address ?? ''
      const forwarded = trustProxy && (peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1') ? request.headers.get('x-real-ip') : null
      // threatcrush-disable-next-line js-ssrf-outbound-request  not an outbound request: Hono's in-process dispatch of the incoming request
      return app.fetch(request, { ip: forwarded || peer })
    },
  })
}

if (import.meta.main) {
  const server = serve()
  console.log(`seo.rank listening on http://${server.hostname}:${server.port}`)
}
