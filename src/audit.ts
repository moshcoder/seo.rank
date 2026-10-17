/**
 * The audit: fetch one page (plus its robots.txt, sitemap and the plain-http
 * redirect), read it, score it, and say what to fix first.
 *
 * Everything runs in-process. No paid API, no headless browser: the cost of an
 * audit is a handful of HTTP requests and a few milliseconds of parsing.
 */
import { FetchRefused, safeFetch, type FetchOptions, type Fetched } from './fetch.js'
import { keywords, parsePage, type PageFacts, type Term } from './parse.js'

export type Status = 'pass' | 'warn' | 'fail' | 'info'
export type Check = { id: string; group: string; label: string; status: Status; weight: number; message: string; fix?: string }
export type Fix = { id: string; label: string; priority: 'high' | 'medium' | 'low'; fix: string }

export type RobotsTxt = { url: string; found: boolean; status: number | null; blocksPage: boolean; sitemaps: string[] }
export type Sitemap = { url: string | null; found: boolean; urls: number; truncated: boolean }

export type Audit = {
  url: string
  finalUrl: string
  fetchedAt: string
  status: number
  contentType: string | null
  timing: { ttfbMs: number; totalMs: number }
  bytes: number
  truncated: boolean
  redirects: { url: string; status: number }[]
  score: number
  grade: 'A' | 'B' | 'C' | 'D' | 'F'
  summary: { pass: number; warn: number; fail: number }
  checks: Check[]
  fixes: Fix[]
  page: Omit<PageFacts, 'text' | 'links'> & { links: { internal: number; external: number; nofollow: number; externalHosts: string[] } }
  robotsTxt: RobotsTxt
  sitemap: Sitemap
  httpsRedirect: { checked: boolean; redirects: boolean; status: number | null }
  keywords: { words: Term[]; phrases: Term[]; totalWords: number }
}

export class AuditError extends Error {}

/** Accept "example.com", "example.com/path", "http://…". Returns null when it cannot be a URL. */
export function normalizeUrl(input: string): string | null {
  let s = String(input ?? '').trim()
  if (!s || s.length > 2048) return null
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s.replace(/^\/+/, '')}`
  try {
    const u = new URL(s)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    if (!u.hostname.includes('.') && !u.hostname.startsWith('[')) return null
    u.hash = ''
    u.hostname = u.hostname.toLowerCase()
    return u.href
  } catch {
    return null
  }
}

// --- robots.txt -------------------------------------------------------------------

type Rule = { allow: boolean; path: string }

export function parseRobots(text: string): { groups: { agents: string[]; rules: Rule[] }[]; sitemaps: string[] } {
  const groups: { agents: string[]; rules: Rule[] }[] = []
  const sitemaps: string[] = []
  let current: { agents: string[]; rules: Rule[] } | null = null
  let lastWasAgent = false
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, '').trim()
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i)
    if (!m) continue
    const key = m[1]!.toLowerCase()
    const value = m[2]!.trim()
    if (key === 'sitemap') {
      if (value && sitemaps.length < 20) sitemaps.push(value)
      continue
    }
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] }
        groups.push(current)
      }
      current.agents.push(value.toLowerCase())
      lastWasAgent = true
      continue
    }
    lastWasAgent = false
    if (current && (key === 'allow' || key === 'disallow')) current.rules.push({ allow: key === 'allow', path: value })
  }
  return { groups, sitemaps }
}

function ruleMatches(rulePath: string, path: string): boolean {
  if (!rulePath) return false
  const anchored = rulePath.endsWith('$')
  const pattern = (anchored ? rulePath.slice(0, -1) : rulePath).replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${pattern}${anchored ? '$' : ''}`).test(path)
}

/** Is `path` disallowed for Googlebot (its own group if it has one, else `*`)? Longest match wins; Allow wins a tie. */
export function robotsBlocks(text: string, path: string, agent = 'googlebot'): boolean {
  const { groups } = parseRobots(text)
  const own = groups.filter((g) => g.agents.some((a) => a !== '*' && agent.startsWith(a)))
  const chosen = own.length ? own : groups.filter((g) => g.agents.includes('*'))
  let best: Rule | null = null
  for (const g of chosen)
    for (const r of g.rules)
      if (ruleMatches(r.path, path) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r
  return best ? !best.allow : false
}

// --- scoring ----------------------------------------------------------------------

const len = (s: string | null) => (s ?? '').length

export function buildChecks(input: {
  fetched: Pick<Fetched, 'url' | 'status' | 'headers' | 'bytes' | 'ttfbMs' | 'truncated'>
  page: PageFacts
  robotsTxt: RobotsTxt
  sitemap: Sitemap
  httpsRedirect: Audit['httpsRedirect']
  terms: { words: Term[]; phrases: Term[] }
}): Check[] {
  const { fetched, page, robotsTxt, sitemap, httpsRedirect, terms } = input
  const url = new URL(fetched.url)
  const h = fetched.headers
  const checks: Check[] = []
  const add = (c: Check) => checks.push(c)

  // Crawlability
  add(
    fetched.status >= 200 && fetched.status < 300
      ? { id: 'status', group: 'Crawlability', label: 'Page answers 200 OK', status: 'pass', weight: 10, message: `HTTP ${fetched.status}.` }
      : { id: 'status', group: 'Crawlability', label: 'Page answers 200 OK', status: 'fail', weight: 10, message: `HTTP ${fetched.status}.`, fix: 'Search engines drop pages that do not answer 200. Fix the error, or redirect (301) the URL to a live page.' },
  )
  const xRobots = h.get('x-robots-tag') ?? ''
  const noindex = /noindex|none/i.test(`${page.robots ?? ''} ${xRobots}`)
  add(
    noindex
      ? { id: 'indexable', group: 'Crawlability', label: 'Page is indexable', status: 'fail', weight: 12, message: `The page asks not to be indexed (${[page.robots, xRobots && `X-Robots-Tag: ${xRobots}`].filter(Boolean).join('; ')}).`, fix: 'Remove "noindex" from the robots meta tag / X-Robots-Tag header if this page should appear in search.' }
      : { id: 'indexable', group: 'Crawlability', label: 'Page is indexable', status: 'pass', weight: 12, message: page.robots ? `robots meta: ${page.robots}` : 'No noindex directive.' },
  )
  if (!robotsTxt.found)
    add({ id: 'robots-txt', group: 'Crawlability', label: 'robots.txt', status: 'warn', weight: 3, message: robotsTxt.status ? `/robots.txt answered HTTP ${robotsTxt.status}.` : '/robots.txt could not be fetched.', fix: 'Publish a /robots.txt (two lines are enough: "User-agent: *" and "Allow: /") with a Sitemap: line pointing at your sitemap.' })
  else if (robotsTxt.blocksPage)
    add({ id: 'robots-txt', group: 'Crawlability', label: 'robots.txt allows this page', status: 'fail', weight: 12, message: 'robots.txt disallows this URL for Googlebot.', fix: 'Remove or narrow the Disallow rule in /robots.txt that matches this path.' })
  else add({ id: 'robots-txt', group: 'Crawlability', label: 'robots.txt allows this page', status: 'pass', weight: 3, message: `Found${robotsTxt.sitemaps.length ? `, lists ${robotsTxt.sitemaps.length} sitemap${robotsTxt.sitemaps.length === 1 ? '' : 's'}` : ''}.` })
  add(
    sitemap.found
      ? { id: 'sitemap', group: 'Crawlability', label: 'XML sitemap', status: 'pass', weight: 4, message: `${sitemap.url} (${sitemap.urls}${sitemap.truncated ? '+' : ''} URL${sitemap.urls === 1 ? '' : 's'}).` }
      : { id: 'sitemap', group: 'Crawlability', label: 'XML sitemap', status: 'warn', weight: 4, message: 'No sitemap in robots.txt or at /sitemap.xml.', fix: 'Publish an XML sitemap and reference it from robots.txt with a "Sitemap:" line.' },
  )
  if (page.canonical) {
    let cu: URL | null = null
    try {
      cu = new URL(page.canonical)
    } catch {}
    const self = cu && cu.href.replace(/\/$/, '') === url.href.replace(/[#].*$/, '').replace(/\/$/, '')
    add(
      !cu
        ? { id: 'canonical', group: 'Crawlability', label: 'Canonical URL', status: 'fail', weight: 5, message: `Invalid canonical: ${page.canonical}`, fix: 'Make rel="canonical" an absolute URL.' }
        : page.canonicalCount > 1
          ? { id: 'canonical', group: 'Crawlability', label: 'Canonical URL', status: 'warn', weight: 5, message: `${page.canonicalCount} canonical tags; search engines may ignore all of them.`, fix: 'Keep exactly one <link rel="canonical">.' }
          : self
            ? { id: 'canonical', group: 'Crawlability', label: 'Canonical URL', status: 'pass', weight: 5, message: `Self-referencing: ${cu.href}` }
            : { id: 'canonical', group: 'Crawlability', label: 'Canonical URL', status: 'info', weight: 0, message: `Points elsewhere: ${cu.href}. Fine if this page is a duplicate of that one; otherwise it will not rank.` },
    )
  } else add({ id: 'canonical', group: 'Crawlability', label: 'Canonical URL', status: 'warn', weight: 5, message: 'No rel="canonical".', fix: `Add <link rel="canonical" href="${url.href}"> so duplicates (tracking parameters, www/non-www) consolidate to one URL.` })

  // Security
  add(
    url.protocol === 'https:'
      ? { id: 'https', group: 'Security', label: 'Served over HTTPS', status: 'pass', weight: 10, message: 'Yes.' }
      : { id: 'https', group: 'Security', label: 'Served over HTTPS', status: 'fail', weight: 10, message: 'The page is plain http.', fix: 'Serve the site over HTTPS (Let\'s Encrypt is free) and 301 http to https.' },
  )
  if (url.protocol === 'https:') {
    if (httpsRedirect.checked)
      add(
        httpsRedirect.redirects
          ? { id: 'http-redirect', group: 'Security', label: 'http redirects to https', status: 'pass', weight: 4, message: `http:// answers ${httpsRedirect.status} to https.` }
          : { id: 'http-redirect', group: 'Security', label: 'http redirects to https', status: 'warn', weight: 4, message: httpsRedirect.status ? `http:// answers ${httpsRedirect.status} without redirecting to https.` : 'http:// did not answer.', fix: 'Redirect every http:// URL to its https:// twin with a 301.' },
      )
    const hsts = h.get('strict-transport-security')
    add(
      hsts && /max-age=\d{6,}/i.test(hsts)
        ? { id: 'hsts', group: 'Security', label: 'HSTS header', status: 'pass', weight: 2, message: hsts }
        : { id: 'hsts', group: 'Security', label: 'HSTS header', status: 'warn', weight: 2, message: hsts ? `Short max-age: ${hsts}` : 'No Strict-Transport-Security header.', fix: 'Send "Strict-Transport-Security: max-age=31536000; includeSubDomains".' },
    )
  }

  // Content
  const tl = len(page.title)
  add(
    !page.title
      ? { id: 'title', group: 'Content', label: 'Title tag', status: 'fail', weight: 10, message: 'No <title>.', fix: 'Add a unique, descriptive <title> of 30–60 characters with the main keyword near the start.' }
      : tl < 30 || tl > 60
        ? { id: 'title', group: 'Content', label: 'Title tag', status: 'warn', weight: 10, message: `${tl} characters: "${page.title}"`, fix: tl < 30 ? 'Lengthen the title to 30–60 characters; short titles waste the most valuable words on the results page.' : 'Shorten the title to about 60 characters so search results do not cut it off.' }
        : { id: 'title', group: 'Content', label: 'Title tag', status: 'pass', weight: 10, message: `${tl} characters: "${page.title}"` },
  )
  if (page.titleCount > 1) add({ id: 'title-dup', group: 'Content', label: 'One title tag', status: 'warn', weight: 2, message: `${page.titleCount} <title> tags.`, fix: 'Keep a single <title> in <head>.' })
  const dl = len(page.description)
  add(
    !page.description
      ? { id: 'description', group: 'Content', label: 'Meta description', status: 'fail', weight: 8, message: 'No meta description.', fix: 'Add <meta name="description"> of 70–160 characters that sells the click.' }
      : dl < 70 || dl > 160
        ? { id: 'description', group: 'Content', label: 'Meta description', status: 'warn', weight: 8, message: `${dl} characters.`, fix: dl < 70 ? 'Expand the meta description to 70–160 characters.' : 'Trim the meta description to about 155 characters so it is not truncated.' }
        : { id: 'description', group: 'Content', label: 'Meta description', status: 'pass', weight: 8, message: `${dl} characters.` },
  )
  const h1s = page.headings.filter((x) => x.level === 1)
  add(
    h1s.length === 1
      ? { id: 'h1', group: 'Content', label: 'One H1 heading', status: 'pass', weight: 8, message: `"${h1s[0]!.text}"` }
      : h1s.length === 0
        ? { id: 'h1', group: 'Content', label: 'One H1 heading', status: 'fail', weight: 8, message: 'No <h1>.', fix: 'Give the page one <h1> that states its topic, ideally with the main keyword.' }
        : { id: 'h1', group: 'Content', label: 'One H1 heading', status: 'warn', weight: 8, message: `${h1s.length} <h1> headings.`, fix: 'Use one <h1> for the page topic and <h2>/<h3> for sections.' },
  )
  let skipped = 0
  let prev = 0
  for (const x of page.headings) {
    if (prev && x.level > prev + 1) skipped++
    prev = x.level
  }
  if (page.headings.length)
    add(
      skipped
        ? { id: 'heading-order', group: 'Content', label: 'Heading outline', status: 'warn', weight: 2, message: `${skipped} skipped heading level${skipped === 1 ? '' : 's'} (e.g. h2 → h4).`, fix: 'Nest headings in order (h1 → h2 → h3) so the outline reads as a table of contents.' }
        : { id: 'heading-order', group: 'Content', label: 'Heading outline', status: 'pass', weight: 2, message: `${page.headings.length} headings, in order.` },
    )
  add(
    page.wordCount >= 300
      ? { id: 'words', group: 'Content', label: 'Enough text', status: 'pass', weight: 5, message: `${page.wordCount} words.` }
      : page.wordCount >= 100
        ? { id: 'words', group: 'Content', label: 'Enough text', status: 'warn', weight: 5, message: `${page.wordCount} words; thin.`, fix: 'Pages under ~300 words rarely rank. Add useful copy that answers what a searcher wants to know.' }
        : { id: 'words', group: 'Content', label: 'Enough text', status: 'fail', weight: 5, message: `${page.wordCount} words in the HTML.`, fix: 'Almost no text is in the HTML. If it is rendered by JavaScript, server-render it; crawlers and AI bots often do not run scripts.' },
  )
  const top = terms.phrases[0]?.term ?? terms.words[0]?.term
  if (top && page.wordCount >= 100) {
    const inTitle = (page.title ?? '').toLowerCase().includes(top)
    const inH1 = h1s.some((x) => x.text.toLowerCase().includes(top))
    add(
      inTitle || inH1
        ? { id: 'focus', group: 'Content', label: 'Top phrase in title or H1', status: 'pass', weight: 3, message: `"${top}" appears in the ${inTitle ? 'title' : 'H1'}.` }
        : { id: 'focus', group: 'Content', label: 'Top phrase in title or H1', status: 'warn', weight: 3, message: `The page repeats "${top}" most, but it is not in the title or H1.`, fix: `If "${top}" is what you want to rank for, put it in the title and H1; if not, the copy is about something else than you think.` },
    )
  }
  if (page.images.total) {
    const missing = page.images.missingAlt
    const ratio = 1 - missing / page.images.total
    add(
      missing === 0
        ? { id: 'alt', group: 'Content', label: 'Image alt text', status: 'pass', weight: 5, message: `All ${page.images.total} images have alt (${page.images.emptyAlt} decorative).` }
        : { id: 'alt', group: 'Content', label: 'Image alt text', status: ratio >= 0.8 ? 'warn' : 'fail', weight: 5, message: `${missing} of ${page.images.total} images have no alt attribute.`, fix: `Add alt text describing each image (alt="" for purely decorative ones).${page.images.missingSamples.length ? ` First: ${page.images.missingSamples[0]}` : ''}` },
    )
  }
  add(
    page.links.internal >= 3
      ? { id: 'internal-links', group: 'Content', label: 'Internal links', status: 'pass', weight: 3, message: `${page.links.internal} internal, ${page.links.external} external${page.links.nofollow ? `, ${page.links.nofollow} nofollow` : ''}.` }
      : { id: 'internal-links', group: 'Content', label: 'Internal links', status: 'warn', weight: 3, message: `${page.links.internal} internal, ${page.links.external} external.`, fix: 'Link to your other important pages with descriptive anchor text; internal links spread ranking and help crawlers find pages.' },
  )

  // Mobile + markup
  add(
    page.viewport && /width\s*=\s*device-width/i.test(page.viewport)
      ? { id: 'viewport', group: 'Mobile & markup', label: 'Mobile viewport', status: 'pass', weight: 6, message: page.viewport }
      : { id: 'viewport', group: 'Mobile & markup', label: 'Mobile viewport', status: 'fail', weight: 6, message: page.viewport ? `Viewport without device-width: ${page.viewport}` : 'No viewport meta tag.', fix: 'Add <meta name="viewport" content="width=device-width, initial-scale=1">; Google indexes the mobile version.' },
  )
  add(
    page.lang
      ? { id: 'lang', group: 'Mobile & markup', label: 'Language declared', status: 'pass', weight: 2, message: `<html lang="${page.lang}">` }
      : { id: 'lang', group: 'Mobile & markup', label: 'Language declared', status: 'warn', weight: 2, message: 'No lang attribute on <html>.', fix: 'Add lang (e.g. <html lang="en">).' },
  )
  add(
    page.charset || /charset=/i.test(h.get('content-type') ?? '')
      ? { id: 'charset', group: 'Mobile & markup', label: 'Character set', status: 'pass', weight: 1, message: 'Declared.' }
      : { id: 'charset', group: 'Mobile & markup', label: 'Character set', status: 'warn', weight: 1, message: 'No charset in the HTML or Content-Type.', fix: 'Add <meta charset="utf-8"> as the first thing in <head>.' },
  )
  add(
    page.favicon
      ? { id: 'favicon', group: 'Mobile & markup', label: 'Favicon', status: 'pass', weight: 1, message: 'Declared.' }
      : { id: 'favicon', group: 'Mobile & markup', label: 'Favicon', status: 'warn', weight: 1, message: 'No <link rel="icon">.', fix: 'Declare a favicon; Google shows it next to mobile results.' },
  )

  // Social + structured data
  const ogMissing = ['title', 'description', 'image'].filter((k) => !page.og[k])
  add(
    ogMissing.length === 0
      ? { id: 'og', group: 'Social & rich results', label: 'Open Graph tags', status: 'pass', weight: 4, message: 'og:title, og:description and og:image are set.' }
      : { id: 'og', group: 'Social & rich results', label: 'Open Graph tags', status: 'warn', weight: 4, message: `Missing ${ogMissing.map((k) => `og:${k}`).join(', ')}.`, fix: 'Add og:title, og:description and og:image (1200×630) so shared links get a proper card.' },
  )
  add(
    page.twitter.card
      ? { id: 'twitter', group: 'Social & rich results', label: 'Twitter / X card', status: 'pass', weight: 2, message: `twitter:card = ${page.twitter.card}` }
      : { id: 'twitter', group: 'Social & rich results', label: 'Twitter / X card', status: 'warn', weight: 2, message: 'No twitter:card.', fix: 'Add <meta name="twitter:card" content="summary_large_image">.' },
  )
  add(
    page.jsonLd.invalid
      ? { id: 'schema', group: 'Social & rich results', label: 'Structured data', status: 'fail', weight: 4, message: `${page.jsonLd.invalid} JSON-LD block${page.jsonLd.invalid === 1 ? ' does' : 's do'} not parse.`, fix: 'Fix the JSON syntax in your application/ld+json blocks; invalid blocks are ignored entirely.' }
      : page.jsonLd.types.length
        ? { id: 'schema', group: 'Social & rich results', label: 'Structured data', status: 'pass', weight: 4, message: `JSON-LD: ${page.jsonLd.types.join(', ')}.` }
        : page.microdata
          ? { id: 'schema', group: 'Social & rich results', label: 'Structured data', status: 'pass', weight: 4, message: 'Microdata (itemscope) found.' }
          : { id: 'schema', group: 'Social & rich results', label: 'Structured data', status: 'warn', weight: 4, message: 'No JSON-LD or microdata.', fix: 'Add schema.org JSON-LD (Organization, WebSite, Article, Product, FAQPage… whichever fits) to be eligible for rich results.' },
  )
  if (page.hreflang.length) {
    const bad = page.hreflang.filter((x) => !/^(x-default|[a-z]{2,3}(-[a-z0-9]{2,8})*)$/i.test(x.lang))
    const self = page.hreflang.some((x) => x.href.replace(/\/$/, '') === url.href.replace(/\/$/, ''))
    add(
      bad.length || !self
        ? { id: 'hreflang', group: 'Social & rich results', label: 'hreflang', status: 'warn', weight: 2, message: `${page.hreflang.length} alternates${bad.length ? `; invalid codes: ${bad.map((x) => x.lang).join(', ')}` : ''}${self ? '' : '; none points back at this page'}.`, fix: 'Each hreflang set must include the page itself and use ISO codes (en, en-GB, x-default).' }
        : { id: 'hreflang', group: 'Social & rich results', label: 'hreflang', status: 'pass', weight: 2, message: `${page.hreflang.length} alternates: ${page.hreflang.map((x) => x.lang).slice(0, 8).join(', ')}.` },
    )
  } else add({ id: 'hreflang', group: 'Social & rich results', label: 'hreflang', status: 'info', weight: 0, message: 'None (only needed for multi-language sites).' })

  // Speed
  add(
    fetched.ttfbMs < 800
      ? { id: 'ttfb', group: 'Speed', label: 'Server response time', status: 'pass', weight: 5, message: `${fetched.ttfbMs} ms to first byte (from seo.rank).` }
      : { id: 'ttfb', group: 'Speed', label: 'Server response time', status: fetched.ttfbMs < 2000 ? 'warn' : 'fail', weight: 5, message: `${fetched.ttfbMs} ms to first byte (from seo.rank).`, fix: 'Cache the HTML (CDN or page cache) and look at slow database queries; aim for under 800 ms.' },
  )
  const kb = Math.round(fetched.bytes / 1024)
  add(
    kb < 150
      ? { id: 'weight', group: 'Speed', label: 'HTML size', status: 'pass', weight: 4, message: `${kb} KB of HTML, ${page.scripts} scripts, ${page.stylesheets} stylesheets.` }
      : { id: 'weight', group: 'Speed', label: 'HTML size', status: kb < 600 && !fetched.truncated ? 'warn' : 'fail', weight: 4, message: `${fetched.truncated ? 'Over ' : ''}${kb} KB of HTML, ${page.scripts} scripts, ${page.stylesheets} stylesheets.`, fix: 'Trim inline scripts, styles, SVG and JSON from the HTML; large documents slow the first paint and may be cut off by crawlers.' },
  )
  const enc = h.get('content-encoding')
  add(
    enc && /gzip|br|zstd|deflate/i.test(enc)
      ? { id: 'compression', group: 'Speed', label: 'Compression', status: 'pass', weight: 2, message: enc }
      : { id: 'compression', group: 'Speed', label: 'Compression', status: 'warn', weight: 2, message: 'HTML is sent uncompressed.', fix: 'Turn on gzip or Brotli for text/html at the web server or CDN.' },
  )
  return checks
}

export function score(checks: Check[]): { score: number; grade: Audit['grade']; fixes: Fix[] } {
  let total = 0
  let earned = 0
  for (const c of checks) {
    if (c.status === 'info' || !c.weight) continue
    total += c.weight
    earned += c.status === 'pass' ? c.weight : c.status === 'warn' ? c.weight * 0.5 : 0
  }
  const s = total ? Math.round((earned / total) * 100) : 0
  const grade = s >= 90 ? 'A' : s >= 80 ? 'B' : s >= 70 ? 'C' : s >= 60 ? 'D' : 'F'
  const fixes = checks
    .filter((c) => (c.status === 'fail' || c.status === 'warn') && c.fix)
    .map((c) => ({ c, impact: c.weight * (c.status === 'fail' ? 1 : 0.5) }))
    .sort((a, b) => b.impact - a.impact)
    .map(({ c, impact }) => ({ id: c.id, label: c.label, priority: (impact >= 6 ? 'high' : impact >= 3 ? 'medium' : 'low') as Fix['priority'], fix: c.fix! }))
  return { score: s, grade, fixes }
}

// --- the audit ---------------------------------------------------------------------

export type AuditOptions = Pick<FetchOptions, 'fetch' | 'resolve'>

async function fetchRobots(origin: URL, path: string, o: AuditOptions): Promise<RobotsTxt> {
  const url = new URL('/robots.txt', origin).href
  try {
    const r = await safeFetch(url, { ...o, timeoutMs: 5_000, maxBytes: 256_000, sameSite: true })
    const type = r.headers.get('content-type') ?? ''
    if (r.status !== 200 || /html/i.test(type)) return { url, found: false, status: r.status, blocksPage: false, sitemaps: [] }
    return { url, found: true, status: r.status, blocksPage: robotsBlocks(r.body, path), sitemaps: parseRobots(r.body).sitemaps }
  } catch {
    return { url, found: false, status: null, blocksPage: false, sitemaps: [] }
  }
}

async function fetchSitemap(origin: URL, listed: string[], o: AuditOptions): Promise<Sitemap> {
  const candidates = [...listed.slice(0, 2), new URL('/sitemap.xml', origin).href, new URL('/sitemap_index.xml', origin).href]
  const seen = new Set<string>()
  for (const url of candidates) {
    if (seen.has(url)) continue
    seen.add(url)
    try {
      const r = await safeFetch(url, { ...o, timeoutMs: 5_000, maxBytes: 1_000_000 })
      if (r.status !== 200 || !/<(urlset|sitemapindex)[\s>]/i.test(r.body.slice(0, 5000))) continue
      return { url: r.url, found: true, urls: (r.body.match(/<loc>/gi) ?? []).length, truncated: r.truncated }
    } catch {}
  }
  return { url: null, found: false, urls: 0, truncated: false }
}

async function checkHttpRedirect(final: URL, o: AuditOptions): Promise<Audit['httpsRedirect']> {
  if (final.protocol !== 'https:') return { checked: false, redirects: false, status: null }
  const plain = new URL(final.href)
  plain.protocol = 'http:'
  try {
    const r = await safeFetch(plain.href, { ...o, timeoutMs: 5_000, maxBytes: 16_000, maxRedirects: 0 })
    return { checked: true, redirects: false, status: r.status }
  } catch (error) {
    // maxRedirects 0: a redirect throws "Too many redirects" after recording the hop; we only want its target.
    if (error instanceof FetchRefused && /Too many redirects/.test(error.message)) return { checked: true, redirects: true, status: 301 }
    return { checked: true, redirects: false, status: null }
  }
}

export async function audit(input: string, options: AuditOptions = {}): Promise<Audit> {
  const url = normalizeUrl(input)
  if (!url) throw new AuditError('Enter a website address, like example.com.')
  let fetched: Fetched
  try {
    fetched = await safeFetch(url, { ...options, timeoutMs: 12_000, maxBytes: 2_000_000, sameSite: true })
  } catch (error) {
    throw new AuditError(error instanceof Error ? error.message : 'Could not fetch the page.')
  }
  const contentType = fetched.headers.get('content-type')
  if (contentType && !/html|xml|text\/plain/i.test(contentType)) throw new AuditError(`That URL is not a web page (Content-Type: ${contentType.split(';')[0]}).`)
  const final = new URL(fetched.url)
  const [page, robotsTxt, httpsRedirect] = await Promise.all([
    parsePage(fetched.body, fetched.url),
    fetchRobots(final, final.pathname + final.search, options),
    checkHttpRedirect(final, options),
  ])
  const sitemap = await fetchSitemap(final, robotsTxt.sitemaps, options)
  const terms = keywords(page.text)
  const checks = buildChecks({ fetched, page, robotsTxt, sitemap, httpsRedirect, terms })
  const { score: s, grade, fixes } = score(checks)
  const { text: _text, links, ...rest } = page
  return {
    url,
    finalUrl: fetched.url,
    fetchedAt: new Date().toISOString(),
    status: fetched.status,
    contentType,
    timing: { ttfbMs: fetched.ttfbMs, totalMs: fetched.totalMs },
    bytes: fetched.bytes,
    truncated: fetched.truncated,
    redirects: fetched.redirects,
    score: s,
    grade,
    summary: { pass: checks.filter((c) => c.status === 'pass').length, warn: checks.filter((c) => c.status === 'warn').length, fail: checks.filter((c) => c.status === 'fail').length },
    checks,
    fixes,
    page: { ...rest, links: { internal: links.internal, external: links.external, nofollow: links.nofollow, externalHosts: links.externalHosts.slice(0, 20) } },
    robotsTxt,
    sitemap,
    httpsRedirect,
    keywords: terms,
  }
}

/** Audits of the same URL within the hour come from memory: words and results only, nothing about who asked. */
export class AuditCache {
  private entries = new Map<string, { at: number; audit: Audit }>()
  constructor(
    private readonly ttlMs = 3_600_000,
    private readonly max = 2_000,
  ) {}
  get(url: string): Audit | null {
    const e = this.entries.get(url)
    if (!e) return null
    if (Date.now() - e.at > this.ttlMs) {
      this.entries.delete(url)
      return null
    }
    return e.audit
  }
  set(url: string, audit: Audit): void {
    this.entries.delete(url)
    this.entries.set(url, { at: Date.now(), audit })
    while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value!)
  }
}
