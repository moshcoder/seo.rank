/**
 * The seo.rank web server: pages and the JSON API.
 *
 * Nothing here writes a log line about a request, and no URL anyone audits is
 * logged. Errors are reported without the URL attached.
 */
import { Hono, type Context } from 'hono'
import { assertFetchable, FetchRefused } from './fetch.js'
import { audit as runAudit, AuditCache, AuditError, normalizeUrl, type Audit, type AuditOptions } from './audit.js'
import { aboutPage, errorPage, homePage, messagePage, resultsPage, SITE } from './html.js'
import { DailyQuota, Gate, type Quota } from './ratelimit.js'

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
}

/** The visitor's address arrives as a binding from serve() (or a test), never from a header the visitor controls. */
type Env = { Bindings: { ip?: string } }

const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': "default-src 'none'; style-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
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
  const inflight = new Map<string, Promise<Audit>>()
  const app = new Hono<Env>()

  app.use('*', async (c, next) => {
    await next()
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) c.header(name, value)
    // Nothing on seo.rank sets a cookie, and nothing ever will by accident.
    c.res.headers.delete('set-cookie')
  })

  const ipOf = (c: Context<Env>) => c.env?.ip || 'unknown'

  /** The one path every surface takes: cache, validate, charge, audit. */
  async function perform(ip: string, raw: string): Promise<Outcome> {
    const url = normalizeUrl(raw)
    if (!url) return { kind: 'invalid', message: 'Enter a website address, like example.com.', quota: quota.peek(ip) }
    const hit = cache.get(url)
    if (hit) return { kind: 'ok', audit: hit, cached: true, quota: quota.peek(ip) }
    // Validation costs nothing (a DNS lookup), so it happens before an audit is charged.
    try {
      await assertFetchable(url, options.resolve)
    } catch (error) {
      return { kind: 'refused', message: error instanceof FetchRefused ? error.message : 'That URL cannot be audited.', quota: quota.peek(ip) }
    }
    const pending = inflight.get(url)
    if (pending) {
      try {
        return { kind: 'ok', audit: await pending, cached: true, quota: quota.peek(ip) }
      } catch (error) {
        return { kind: 'failed', message: error instanceof AuditError ? error.message : 'The audit failed.', quota: quota.peek(ip) }
      }
    }
    if (!gate.tryEnter()) return { kind: 'busy', quota: quota.peek(ip) }
    try {
      const taken = quota.take(ip)
      if (!taken.ok) return { kind: taken.reason === 'visitor' ? 'limited' : 'capped', quota: taken.quota }
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
      gate.leave()
    }
  }

  const rateHeaders = (c: Context<Env>, q: Quota) => {
    c.header('x-ratelimit-limit', String(q.limit))
    c.header('x-ratelimit-remaining', String(q.remaining))
    c.header('x-ratelimit-reset', q.resetAt)
  }

  app.get('/', (c) => c.html(homePage(quota.peek(ipOf(c)), deps.pitVerify)))
  app.get('/about', (c) => c.html(aboutPage()))
  app.get('/health', (c) => c.json({ ok: true, version: VERSION, today: quota.stats() }, 200, { 'cache-control': 'no-store' }))
  app.get('/robots.txt', (c) => c.body(`User-agent: *\nDisallow: /audit\nDisallow: /api/\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`, 200, { 'content-type': 'text/plain; charset=utf-8' }))
  app.get('/sitemap.xml', (c) =>
    c.body(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['/', '/about'].map((p) => `<url><loc>${SITE}${p}</loc></url>`).join('')}</urlset>`, 200, { 'content-type': 'application/xml; charset=utf-8' }),
  )

  app.get('/audit', async (c) => {
    const raw = (c.req.query('url') ?? '').trim()
    if (!raw) return c.redirect('/', 302)
    c.header('cache-control', 'no-store')
    const ip = ipOf(c)
    const r = await perform(ip, raw)
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

  const apiAudit = async (c: Context<Env>, raw: string) => {
    if (!raw.trim()) return c.json({ error: 'url is required' }, 400)
    const r = await perform(ipOf(c), raw)
    rateHeaders(c, r.quota)
    const q = { limit: r.quota.limit, remaining: r.quota.remaining, resetAt: r.quota.resetAt }
    switch (r.kind) {
      case 'ok':
        return c.json({ ...r.audit, cached: r.cached, quota: q })
      case 'invalid':
      case 'refused':
        return c.json({ error: r.message, quota: q }, 400)
      case 'failed':
        return c.json({ error: r.message, quota: q }, 422)
      case 'limited':
        c.header('retry-after', String(r.quota.retryAfter))
        return c.json({ error: `Free limit reached: ${r.quota.limit} audits per day. Resets at ${r.quota.resetAt}. Run it yourself with no limit: bunx seorank audit --local <url>`, quota: q }, 429)
      case 'capped':
        c.header('retry-after', String(r.quota.retryAfter))
        return c.json({ error: 'seo.rank has reached its daily audit cap. Try again after midnight UTC, or run it yourself: bunx seorank audit --local <url>', quota: q }, 503)
      case 'busy':
        c.header('retry-after', '10')
        return c.json({ error: 'Busy; try again in a few seconds.', quota: q }, 503)
    }
  }

  app.get('/api/audit', (c) => apiAudit(c, c.req.query('url') ?? ''))
  app.post('/api/audit', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { url?: unknown }
    return apiAudit(c, typeof body.url === 'string' ? body.url : '')
  })
  app.get('/api/quota', (c) => {
    const q = quota.peek(ipOf(c))
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

export function serve(options: { port?: number; hostname?: string } = {}) {
  const env = process.env
  const app = createApp({ ...(env.PIT_VERIFY ? { pitVerify: env.PIT_VERIFY } : {}) })
  const trustProxy = (env.SEORANK_TRUST_PROXY ?? '1') === '1'
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
