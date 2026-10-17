import { describe, expect, it } from 'bun:test'
import { createApp } from '../src/server.ts'
import { DailyQuota } from '../src/ratelimit.ts'
import { fakeWeb } from './fixtures.ts'
import { ringBar, ringSites, setRing } from '../src/ring.ts'

const make = (opts: { pitVerify?: string; quota?: DailyQuota } = {}) => {
  const web = fakeWeb()
  const app = createApp({ auditOptions: web, quota: opts.quota ?? new DailyQuota(10, 2000), ...(opts.pitVerify ? { pitVerify: opts.pitVerify } : {}) })
  const get = (path: string, ip = '203.0.113.7') => app.fetch(new Request(`http://seo.test${path}`), { ip })
  return { app, get, web }
}

describe('pages', () => {
  it('serves the homepage with security headers, no cookies, and the remaining count', async () => {
    const { get } = make()
    const r = await get('/')
    expect(r.status).toBe(200)
    expect(r.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(r.headers.get('set-cookie')).toBeNull()
    const html = await r.text()
    expect(html).toContain('<b>10</b> of 10 free audits left today')
    expect(html).not.toContain('pit-verify')
    expect(html).toContain('https://pit.world/b/seo.rank')
  })
  it('renders the pit-verify meta when configured', async () => {
    const html = await (await make({ pitVerify: 'abc123' }).get('/')).text()
    expect(html).toContain('<meta name="pit-verify" content="abc123">')
  })
  it('renders a results page', async () => {
    const r = await make().get('/audit?url=good.test')
    expect(r.status).toBe(200)
    const html = await r.text()
    expect(html).toContain('good.test')
    expect(html).toContain('All checks')
    expect(html).toContain('<b>9</b> of 10')
  })
  it('health answers', async () => {
    expect(await (await make().get('/health')).json()).toMatchObject({ ok: true })
  })
})

describe('the free limit', () => {
  it('allows 10 fresh audits a day per visitor, then 429 with Retry-After; cached results are free', async () => {
    const { get } = make()
    for (let i = 0; i < 10; i++) {
      const r = await get(`/api/audit?url=https://good.test/?p=${i}`)
      expect(r.status).toBe(200)
      expect(r.headers.get('x-ratelimit-remaining')).toBe(String(9 - i))
    }
    const cached = await get('/api/audit?url=https://good.test/?p=3')
    expect(cached.status).toBe(200)
    expect((await cached.json()).cached).toBe(true)
    const over = await get('/api/audit?url=https://good.test/?p=99')
    expect(over.status).toBe(429)
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0)
    expect((await get('/audit?url=https://good.test/?p=98')).status).toBe(429)
    // Someone else is unaffected.
    expect((await get('/api/audit?url=https://good.test/?p=99', '198.51.100.1')).status).toBe(200)
    expect(await (await get('/api/quota')).json()).toMatchObject({ limit: 10, remaining: 0 })
  })
  it('does not charge for URLs refused before any fetch', async () => {
    const { get } = make()
    expect((await get('/api/audit?url=http://internal.test/')).status).toBe(400)
    expect((await get('/api/audit?url=javascript:1')).status).toBe(400)
    expect(await (await get('/api/quota')).json()).toMatchObject({ remaining: 10 })
  })
  it('stops everyone at the global cap with 503', async () => {
    const { get } = make({ quota: new DailyQuota(10, 2) })
    expect((await get('/api/audit?url=https://good.test/?a', '1.1.1.1')).status).toBe(200)
    expect((await get('/api/audit?url=https://good.test/?b', '1.1.1.2')).status).toBe(200)
    const r = await get('/api/audit?url=https://good.test/?c', '1.1.1.3')
    expect(r.status).toBe(503)
    expect(r.headers.get('retry-after')).toBeTruthy()
  })
  it('resets at UTC midnight', () => {
    let now = Date.UTC(2026, 9, 17, 23, 59)
    const q = new DailyQuota(1, 100, () => now)
    expect(q.take('a').ok).toBe(true)
    expect(q.take('a').ok).toBe(false)
    now = Date.UTC(2026, 9, 18, 0, 1)
    expect(q.take('a').ok).toBe(true)
  })
})

describe('the Moshpit ring bar', () => {
  const page = async (headers: Record<string, string>) =>
    (await createApp({ auditOptions: fakeWeb(), quota: new DailyQuota(10, 2000) }).fetch(new Request('http://seo.rank/', { headers }), { ip: '203.0.113.7' })).text()

  it('links Moshpit names directly for a visitor who reached seo.rank on Moshpit DNS', async () => {
    const html = await page({ host: 'seo.rank' })
    expect(html).toContain('<nav class="ring-bar"')
    expect(html).toContain('<a href="https://seo.rank/" aria-current="page"')
    expect(html).toContain('href="https://family.ancestry/"')
    expect(html).toContain('random?from=seo.rank&amp;direct=1')
    expect(html).not.toContain('<!--ring-bar-->')
  })

  it('links through the gateway when the page came through it, or by any other host', async () => {
    for (const headers of [{ host: 'seo.rank', 'x-moshpit-name': 'seo.rank' }, { host: '127.0.0.1:8790' }] as Record<string, string>[]) {
      const html = await page(headers)
      expect(html).toContain('href="https://pit.moshcode.sh/n/family.ancestry"')
      expect(html).toContain('href="https://pit.world/"')
      expect(html).not.toContain('direct=1')
    }
  })

  it('takes the member list from pit.world/api/ring and ignores a broken one', () => {
    const before = ringSites()
    expect(setRing({ nope: true })).toBe(false)
    expect(setRing({ sites: [{ name: '<script>' }] })).toBe(false)
    expect(ringSites()).toBe(before)
    expect(setRing({ sites: [...before, { name: 'new.pit', about: 'x', moshpit: true }] })).toBe(true)
    expect(ringBar('seo.rank', false)).toContain('https://pit.moshcode.sh/n/new.pit')
    setRing({ sites: before })
  })
})
