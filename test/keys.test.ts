import { describe, expect, it } from 'bun:test'
import { createApp } from '../src/server.ts'
import { DailyQuota, Gate } from '../src/ratelimit.ts'
import { KeyQuota, matchKey, parseApiKeys, presentedKey } from '../src/keys.ts'
import { fakeWeb } from './fixtures.ts'

const KEY = 'og_0123456789abcdef0123456789abcdef'
const OTHER = 'zz_fedcba9876543210fedcba9876543210'

const make = (opts: { keyQuota?: KeyQuota; quota?: DailyQuota; keyGate?: Gate } = {}) => {
  const web = fakeWeb()
  const app = createApp({
    auditOptions: web,
    quota: opts.quota ?? new DailyQuota(2, 3),
    apiKeys: parseApiKeys(`outreachgraph:${KEY},${OTHER}`),
    keyQuota: opts.keyQuota ?? new KeyQuota(50_000),
    ...(opts.keyGate ? { keyGate: opts.keyGate } : {}),
  })
  const get = (path: string, headers: Record<string, string> = {}, ip = '203.0.113.7') => app.fetch(new Request(`http://seo.test${path}`, { headers }), { ip })
  return { app, get }
}

describe('parseApiKeys', () => {
  it('reads name:key pairs and bare keys, and drops short keys', () => {
    const keys = parseApiKeys(` outreachgraph:${KEY} , ${OTHER}, short:abc, ,`)
    expect(keys.map((k) => k.name)).toEqual(['outreachgraph', 'key2'])
    expect(parseApiKeys(undefined)).toEqual([])
  })
  it('matches in constant time and only the right key', () => {
    const keys = parseApiKeys(`a:${KEY},b:${OTHER}`)
    expect(matchKey(keys, KEY)).toBe('a')
    expect(matchKey(keys, OTHER)).toBe('b')
    expect(matchKey(keys, KEY.slice(0, -1))).toBeNull()
    expect(matchKey([], KEY)).toBeNull()
  })
  it('accepts Bearer and X-API-Key', () => {
    expect(presentedKey(new Headers({ authorization: `Bearer ${KEY}` }))).toBe(KEY)
    expect(presentedKey(new Headers({ 'x-api-key': KEY }))).toBe(KEY)
    expect(presentedKey(new Headers({ authorization: 'Basic abc' }))).toBeNull()
    expect(presentedKey(new Headers())).toBeNull()
  })
})

describe('keyed calls', () => {
  it('skip the visitor limit and the public global cap, with their own quota headers', async () => {
    const { get } = make()
    for (let i = 0; i < 6; i++) {
      const r = await get(`/api/audit?url=https://good.test/?k=${i}`, { authorization: `Bearer ${KEY}` })
      expect(r.status).toBe(200)
      expect(r.headers.get('x-ratelimit-limit')).toBe('50000')
      expect(r.headers.get('x-ratelimit-remaining')).toBe(String(49_999 - i))
    }
    // The public tier was not touched: the same IP still has its 2 free audits, and the global cap (3) is untouched.
    expect(await (await get('/api/quota')).json()).toMatchObject({ limit: 2, remaining: 2 })
    const health = await (await get('/health')).json()
    expect(health.today.globalUsed).toBe(0)
    expect(health.keyed).toEqual([
      { name: 'outreachgraph', used: 6, limit: 50_000 },
      { name: 'key2', used: 0, limit: 50_000 },
    ])
    expect(JSON.stringify(health)).not.toContain(KEY)
  })
  it('unkeyed calls still hit the free limit', async () => {
    const { get } = make()
    expect((await get('/api/audit?url=https://good.test/?u=1')).status).toBe(200)
    expect((await get('/api/audit?url=https://good.test/?u=2')).status).toBe(200)
    expect((await get('/api/audit?url=https://good.test/?u=3')).status).toBe(429)
    expect((await get('/api/audit?url=https://good.test/?u=4', { 'x-api-key': KEY })).status).toBe(200)
  })
  it('a wrong key is 401, never a fall back to the free tier', async () => {
    const { get } = make()
    const r = await get('/api/audit?url=https://good.test/', { authorization: 'Bearer nope-nope-nope-nope-nope' })
    expect(r.status).toBe(401)
    expect(await r.text()).not.toContain('nope')
    expect((await get('/api/quota', { 'x-api-key': 'wrong-wrong-wrong-wrong' })).status).toBe(401)
  })
  it('enforce the per-key daily cap with 429 and Retry-After', async () => {
    const { get } = make({ keyQuota: new KeyQuota(2) })
    const h = { authorization: `Bearer ${KEY}` }
    expect((await get('/api/audit?url=https://good.test/?c=1', h)).status).toBe(200)
    expect((await get('/api/audit?url=https://good.test/?c=2', h)).status).toBe(200)
    const over = await get('/api/audit?url=https://good.test/?c=3', h)
    expect(over.status).toBe(429)
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0)
    // Cached results stay free, and another key is unaffected.
    expect((await get('/api/audit?url=https://good.test/?c=1', h)).status).toBe(200)
    expect((await get('/api/audit?url=https://good.test/?c=3', { 'x-api-key': OTHER })).status).toBe(200)
    expect(await (await get('/api/quota', h)).json()).toMatchObject({ limit: 2, remaining: 0 })
  })
  it('respect their own concurrency gate', async () => {
    const { get } = make({ keyGate: new Gate(0) })
    const r = await get('/api/audit?url=https://good.test/', { authorization: `Bearer ${KEY}` })
    expect(r.status).toBe(503)
    expect(r.headers.get('retry-after')).toBe('10')
  })
})

describe('fields=summary', () => {
  it('returns score, grade, the top N fixes and checkedAt only', async () => {
    const { get } = make()
    const r = await get('/api/audit?url=poor.test&fields=summary&top=3', { authorization: `Bearer ${KEY}` })
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(Object.keys(body).sort()).toEqual(['cached', 'checkedAt', 'finalUrl', 'fixes', 'grade', 'quota', 'score', 'status', 'summary', 'url'])
    expect(body.fixes.length).toBe(3)
    expect(typeof body.score).toBe('number')
    expect(body.checks).toBeUndefined()
  })
})
