/**
 * Read a page's SEO-relevant parts in one streaming pass with Bun's built-in
 * HTMLRewriter (lol-html): no DOM, no headless browser, a few milliseconds a page.
 */

export type Heading = { level: number; text: string }

export type PageFacts = {
  lang: string | null
  title: string | null
  titleCount: number
  description: string | null
  descriptionCount: number
  robots: string | null
  viewport: string | null
  charset: boolean
  canonical: string | null
  canonicalCount: number
  favicon: boolean
  og: Record<string, string>
  twitter: Record<string, string>
  hreflang: { lang: string; href: string }[]
  headings: Heading[]
  images: { total: number; missingAlt: number; emptyAlt: number; missingSamples: string[] }
  links: { internal: number; external: number; nofollow: number; internalUrls: string[]; externalHosts: string[] }
  jsonLd: { types: string[]; invalid: number; blocks: number }
  microdata: boolean
  scripts: number
  stylesheets: number
  text: string
  wordCount: number
}

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  hellip: '…', copy: '©', reg: '®', trade: '™', middot: '·', bull: '•', laquo: '«', raquo: '»', eacute: 'é', egrave: 'è', aacute: 'á',
  agrave: 'à', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', uuml: 'ü', ouml: 'ö', auml: 'ä', ccedil: 'ç', szlig: 'ß', times: '×', euro: '€', pound: '£',
}

export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (m, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ' '
    }
    return NAMED[code.toLowerCase()] ?? m
  })
}

const clean = (s: string) => decodeEntities(s).replace(/\s+/g, ' ').trim()

function resolveUrl(href: string, base: URL): URL | null {
  try {
    return new URL(href.trim(), base)
  } catch {
    return null
  }
}

const bareHost = (h: string) => h.toLowerCase().replace(/^www\./, '')

function ldTypes(node: unknown, out: Set<string>, depth = 0): void {
  if (depth > 6 || node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const n of node) ldTypes(n, out, depth + 1)
    return
  }
  const obj = node as Record<string, unknown>
  const t = obj['@type']
  if (typeof t === 'string') out.add(t)
  else if (Array.isArray(t)) for (const x of t) if (typeof x === 'string') out.add(x)
  if (obj['@graph']) ldTypes(obj['@graph'], out, depth + 1)
  for (const [k, v] of Object.entries(obj)) if (k !== '@graph' && typeof v === 'object') ldTypes(v, out, depth + 1)
}

/**
 * Elements whose text is not page copy. <script> and <title> are handled by their
 * own handlers: lol-html keeps only one end-tag callback per element.
 */
const SKIP = new Set(['style', 'noscript', 'template', 'svg', 'textarea', 'select', 'iframe', 'object'])

export async function parsePage(html: string, pageUrl: string): Promise<PageFacts> {
  const base = new URL(pageUrl)
  const f: PageFacts = {
    lang: null, title: null, titleCount: 0, description: null, descriptionCount: 0, robots: null, viewport: null, charset: false,
    canonical: null, canonicalCount: 0, favicon: false, og: {}, twitter: {}, hreflang: [], headings: [],
    images: { total: 0, missingAlt: 0, emptyAlt: 0, missingSamples: [] },
    links: { internal: 0, external: 0, nofollow: 0, internalUrls: [], externalHosts: [] },
    jsonLd: { types: [], invalid: 0, blocks: 0 }, microdata: false, scripts: 0, stylesheets: 0, text: '', wordCount: 0,
  }
  let baseUrl = base
  let skipDepth = 0
  let titleBuf: string | null = null
  const headingStack: { level: number; buf: string }[] = []
  let ldBuf: string | null = null
  const textParts: string[] = []
  let textSize = 0
  const types = new Set<string>()
  const internal = new Set<string>()
  const external = new Set<string>()

  // End tags are only observable on elements that can have content and were not written as <x/>.
  const onEnd = (el: any, fn: () => void) => {
    if (el.selfClosing || el.canHaveContent === false) return false
    try {
      el.onEndTag(fn)
      return true
    } catch {
      return false
    }
  }

  const rewriter = new HTMLRewriter()
    .on('html', { element: (el) => void (f.lang ??= el.getAttribute('lang')?.trim() || null) })
    .on('base[href]', { element: (el) => void (baseUrl = resolveUrl(el.getAttribute('href')!, base) ?? base) })
    .on('title', {
      element(el) {
        // An <svg><title> is a tooltip, not the page title.
        if (skipDepth > 0 && f.titleCount > 0) return
        f.titleCount++
        const first = f.titleCount === 1
        if (first) titleBuf = ''
        if (
          onEnd(el, () => {
            skipDepth--
            if (first) {
              f.title = clean(titleBuf ?? '')
              titleBuf = null
            }
          })
        )
          skipDepth++
      },
      text(t) {
        if (titleBuf !== null) titleBuf += t.text
      },
    })
    .on('meta', {
      element(el) {
        const name = (el.getAttribute('name') ?? '').toLowerCase().trim()
        const prop = (el.getAttribute('property') ?? '').toLowerCase().trim()
        const content = clean(el.getAttribute('content') ?? '')
        if (el.hasAttribute('charset') || (el.getAttribute('http-equiv') ?? '').toLowerCase() === 'content-type') f.charset = true
        if (name === 'description') {
          f.descriptionCount++
          f.description ??= content
        } else if (name === 'robots' || name === 'googlebot') f.robots = f.robots ? `${f.robots}, ${content}` : content
        else if (name === 'viewport') f.viewport = content
        else if (name.startsWith('twitter:')) f.twitter[name.slice(8)] ??= content
        if (prop.startsWith('og:')) f.og[prop.slice(3)] ??= content
        else if (prop.startsWith('twitter:')) f.twitter[prop.slice(8)] ??= content
      },
    })
    .on('link[rel]', {
      element(el) {
        const rel = (el.getAttribute('rel') ?? '').toLowerCase().split(/\s+/)
        const href = el.getAttribute('href')
        if (rel.includes('canonical') && href) {
          f.canonicalCount++
          f.canonical ??= resolveUrl(decodeEntities(href), baseUrl)?.href ?? href
        }
        if (rel.includes('icon') || rel.includes('apple-touch-icon')) f.favicon = true
        if (rel.includes('stylesheet')) f.stylesheets++
        const hl = el.getAttribute('hreflang')
        if (rel.includes('alternate') && hl && href) f.hreflang.push({ lang: hl.trim(), href: resolveUrl(decodeEntities(href), baseUrl)?.href ?? href })
      },
    })
    .on('h1, h2, h3, h4, h5, h6', {
      element(el) {
        if (skipDepth > 0) return
        const level = Number(el.tagName.slice(1))
        const entry = { level, buf: '' }
        if (
          onEnd(el, () => {
            const i = headingStack.lastIndexOf(entry)
            if (i !== -1) headingStack.splice(i, 1)
            f.headings.push({ level, text: clean(entry.buf).slice(0, 200) })
          })
        )
          headingStack.push(entry)
        else f.headings.push({ level, text: '' })
      },
    })
    .on('img', {
      element(el) {
        f.images.total++
        if (!el.hasAttribute('alt')) {
          f.images.missingAlt++
          const src = el.getAttribute('src') ?? el.getAttribute('data-src') ?? ''
          if (src && f.images.missingSamples.length < 5) f.images.missingSamples.push(resolveUrl(decodeEntities(src), baseUrl)?.href ?? src)
        } else if (!(el.getAttribute('alt') ?? '').trim()) f.images.emptyAlt++
      },
    })
    .on('a[href]', {
      element(el) {
        const href = decodeEntities(el.getAttribute('href') ?? '').trim()
        if (!href || href.startsWith('#') || /^(javascript|mailto|tel|sms|data):/i.test(href)) return
        const u = resolveUrl(href, baseUrl)
        if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) return
        if ((el.getAttribute('rel') ?? '').toLowerCase().split(/\s+/).some((r) => r === 'nofollow' || r === 'ugc' || r === 'sponsored')) f.links.nofollow++
        u.hash = ''
        if (bareHost(u.hostname) === bareHost(base.hostname)) {
          f.links.internal++
          if (internal.size < 500) internal.add(u.href)
        } else {
          f.links.external++
          if (external.size < 200) external.add(u.hostname.toLowerCase())
        }
      },
    })
    .on('script', {
      element(el) {
        const type = (el.getAttribute('type') ?? '').toLowerCase().trim()
        if (el.hasAttribute('src')) f.scripts++
        const ld = type === 'application/ld+json'
        if (ld) {
          f.jsonLd.blocks++
          ldBuf = ''
        }
        if (
          onEnd(el, () => {
            skipDepth--
            if (!ld) return
            try {
              ldTypes(JSON.parse(ldBuf ?? ''), types)
            } catch {
              f.jsonLd.invalid++
            }
            ldBuf = null
          })
        )
          skipDepth++
      },
      text(t) {
        if (ldBuf !== null && ldBuf.length < 200_000) ldBuf += t.text
      },
    })
    .on('[itemscope]', { element: () => void (f.microdata = true) })
    .on('*', {
      element(el) {
        if (SKIP.has(el.tagName)) {
          if (onEnd(el, () => void skipDepth--)) skipDepth++
        }
      },
    })
    .onDocument({
      text(t) {
        if (headingStack.length) for (const h of headingStack) h.buf += t.text
        if (skipDepth > 0 || textSize > 600_000) return
        textParts.push(t.text)
        textSize += t.text.length
        // Separate text nodes so the end of one block does not glue onto the next word.
        if (t.lastInTextNode) textParts.push('\n')
      },
    })

  await rewriter.transform(new Response(html)).arrayBuffer()

  // A title with no end tag (rare, broken pages) still counts.
  if (titleBuf !== null) f.title = clean(titleBuf)
  f.jsonLd.types = [...types].slice(0, 30)
  f.links.internalUrls = [...internal]
  f.links.externalHosts = [...external]
  f.text = decodeEntities(textParts.join('')).replace(/[ \t\r\f\v ]+/g, ' ').replace(/ *\n[\s]*/g, '\n').trim()
  f.wordCount = (f.text.match(WORD) ?? []).length
  return f
}

export const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu

// prettier-ignore
const STOP = new Set(`a about above after again against all also am an and any are aren't as at be because been before being below between both but by can can't cannot could couldn't did didn't do does doesn't doing don't down during each few for from further get got had hadn't has hasn't have haven't having he he'd he'll he's her here here's hers herself him himself his how how's however i i'd i'll i'm i've if in into is isn't it it's its itself just let's like may me might more most much must mustn't my myself new no nor not now of off on once one only or other ought our ours ourselves out over own per same shan't she she'd she'll she's should shouldn't since so some such than that that's the their theirs them themselves then there there's these they they'd they'll they're they've this those though through to too two under until up upon us use used using very via was wasn't we we'd we'll we're we've were weren't what what's when when's where where's whether which while who who's whom why why's will with within without won't would wouldn't yet you you'd you'll you're you've your yours yourself yourselves etc vs re ll ve s t d m www http https com org net html amp nbsp`.split(' '))

export type Term = { term: string; count: number; density: number }

/** The words and two-to-three word phrases a page repeats most, stopwords aside. */
export function keywords(text: string, top = 12): { words: Term[]; phrases: Term[]; totalWords: number } {
  const phrases = text.toLowerCase().split(/[.!?,;:()[\]{}|/\\"“”«»•·–—…\n]+/)
  const uni = new Map<string, number>()
  const multi = new Map<string, number>()
  let total = 0
  for (const phrase of phrases) {
    const tokens = (phrase.match(WORD) ?? []).map((t) => t.replace(/[’]/g, "'").replace(/^['-]+|['-]+$/g, '')).filter(Boolean)
    total += tokens.length
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!
      const useful = (w: string) => w.length >= 3 && !STOP.has(w) && !/^\d+[a-z]{0,3}$/.test(w)
      if (useful(t)) uni.set(t, (uni.get(t) ?? 0) + 1)
      for (const n of [2, 3]) {
        if (i + n > tokens.length) break
        const gram = tokens.slice(i, i + n)
        if (!useful(gram[0]!) || !useful(gram[n - 1]!) || gram.some((w) => /^\d+$/.test(w) || w.length < 2)) continue
        const key = gram.join(' ')
        multi.set(key, (multi.get(key) ?? 0) + 1)
      }
    }
  }
  const rank = (m: Map<string, number>, min: number) =>
    [...m.entries()]
      .filter(([, c]) => c >= min)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, top)
      .map(([term, count]) => ({ term, count, density: total ? Math.round(((count * term.split(' ').length) / total) * 1000) / 10 : 0 }))
  return { words: rank(uni, 1), phrases: rank(multi, 2), totalWords: total }
}
