import { describe, expect, it } from 'bun:test'
import { audit, AuditError, normalizeUrl, robotsBlocks, parseRobots } from '../src/audit.ts'
import { isPublicAddress, assertFetchable, FetchRefused } from '../src/fetch.ts'
import { decodeEntities, keywords, parsePage } from '../src/parse.ts'
import { GOOD, fakeWeb } from './fixtures.ts'

describe('isPublicAddress', () => {
  it('refuses private, loopback, link-local and mapped addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::a00:1', '2001:db8::1', 'not-an-ip'])
      expect(isPublicAddress(ip)).toBe(false)
  })
  it('allows public addresses', () => {
    for (const ip of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) expect(isPublicAddress(ip)).toBe(true)
  })
})

describe('assertFetchable', () => {
  const { resolve } = fakeWeb()
  const refused = async (u: string) => {
    try {
      await assertFetchable(u, resolve)
      return false
    } catch (e) {
      return e instanceof FetchRefused
    }
  }
  it('refuses non-http, odd ports, credentials, internal names and private resolutions', async () => {
    for (const u of ['ftp://good.test/', 'https://good.test:8443/', 'https://u:p@good.test/', 'http://localhost/', 'http://router.local/', 'http://internal.test/', 'http://nx.test/', 'http://[::1]/', 'http://127.0.0.1/']) expect(await refused(u)).toBe(true)
  })
  it('allows a public site', async () => {
    expect(await refused('https://good.test/')).toBe(false)
  })
})

describe('normalizeUrl', () => {
  it('adds https and drops the fragment', () => {
    expect(normalizeUrl('Example.com/Page#x')).toBe('https://example.com/Page')
    expect(normalizeUrl('http://example.com')).toBe('http://example.com/')
    expect(normalizeUrl('javascript:alert(1)')).toBeNull()
    expect(normalizeUrl('nodot')).toBeNull()
    expect(normalizeUrl('')).toBeNull()
  })
})

describe('robots.txt', () => {
  it('applies longest-match with Allow winning ties, and Googlebot groups over *', () => {
    const txt = 'User-agent: *\nDisallow: /private\nAllow: /private/ok\nDisallow: /*.pdf$\n\nUser-agent: Googlebot\nUser-agent: Bingbot\nDisallow: /nogoogle\nSitemap: https://x.test/s.xml'
    expect(robotsBlocks(txt, '/private/x', 'otherbot')).toBe(true)
    expect(robotsBlocks(txt, '/private/ok/1', 'otherbot')).toBe(false)
    expect(robotsBlocks(txt, '/a/b.pdf', 'otherbot')).toBe(true)
    expect(robotsBlocks(txt, '/a/b.pdfx', 'otherbot')).toBe(false)
    expect(robotsBlocks(txt, '/private/x')).toBe(false) // Googlebot has its own group
    expect(robotsBlocks(txt, '/nogoogle/1')).toBe(true)
    expect(parseRobots(txt).sitemaps).toEqual(['https://x.test/s.xml'])
    expect(robotsBlocks('User-agent: *\nDisallow:', '/')).toBe(false)
    expect(robotsBlocks('User-agent: *\nDisallow: /', '/')).toBe(true)
  })
})

describe('parsePage', () => {
  it('reads head tags, headings, images, links, JSON-LD and body text', async () => {
    const f = await parsePage(GOOD, 'https://good.test/')
    expect(f.title).toBe('Handmade Walnut Cutting Boards | Example Woodshop')
    expect(f.lang).toBe('en')
    expect(f.canonical).toBe('https://good.test/')
    expect(f.headings.map((h) => [h.level, h.text])).toEqual([[1, 'Walnut cutting boards & more'], [2, 'Why walnut cutting boards'], [3, 'Care']])
    expect(f.images).toMatchObject({ total: 2, missingAlt: 0, emptyAlt: 1 })
    expect(f.links).toMatchObject({ internal: 3, external: 1, nofollow: 1 })
    expect(f.jsonLd.types.sort()).toEqual(['Organization', 'Product'])
    expect(f.hreflang).toHaveLength(2)
    expect(f.text).not.toContain('script words')
    expect(f.text).not.toContain('color:red')
    expect(f.wordCount).toBeGreaterThan(300)
  })
  it('decodes entities', () => {
    expect(decodeEntities('a &amp; b &#39;c&#x27; &rsquo; &bogus;')).toBe("a & b 'c' ’ &bogus;")
  })
})

describe('keywords', () => {
  it('ranks repeated words and phrases without stopwords', () => {
    const k = keywords('The walnut board. The walnut board is great. A walnut board, again.')
    expect(k.words[0]!.term).toBe('board')
    expect(k.phrases[0]).toMatchObject({ term: 'walnut board', count: 3 })
    expect(k.words.some((w) => w.term === 'the')).toBe(false)
  })
})

describe('audit', () => {
  it('scores a good page highly with robots, sitemap and the http redirect found', async () => {
    const web = fakeWeb()
    const a = await audit('good.test', web)
    expect(a.status).toBe(200)
    expect(a.robotsTxt).toMatchObject({ found: true, blocksPage: false })
    expect(a.sitemap).toMatchObject({ found: true, urls: 2 })
    expect(a.httpsRedirect).toMatchObject({ checked: true, redirects: true })
    expect(a.summary.fail).toBe(0)
    expect(a.score).toBeGreaterThanOrEqual(90)
    expect(a.grade).toBe('A')
    expect(a.keywords.phrases.map((t) => t.term)).toContain('walnut cutting boards')
  })
  it('flags a poor page and orders fixes by impact', async () => {
    const a = await audit('https://www.poor.test/', fakeWeb())
    expect(a.finalUrl).toBe('https://poor.test/')
    const status = Object.fromEntries(a.checks.map((c) => [c.id, c.status]))
    expect(status).toMatchObject({ indexable: 'fail', description: 'fail', h1: 'fail', viewport: 'fail', alt: 'fail', schema: 'fail', title: 'warn', 'heading-order': 'warn' })
    expect(a.score).toBeLessThan(50)
    expect(a.fixes[0]!.id).toBe('indexable')
    expect(a.fixes[0]!.priority).toBe('high')
  })
  it('refuses off-site redirects and redirects into private space', async () => {
    await expect(audit('https://hop.test/', fakeWeb())).rejects.toThrow(/off-site/)
    await expect(audit('https://rebind.test/', fakeWeb())).rejects.toThrow(AuditError)
    await expect(audit('http://internal.test/', fakeWeb())).rejects.toThrow(/public internet/)
  })
})
