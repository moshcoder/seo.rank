/**
 * Server-rendered pages. No JavaScript of our own and no cookies. Two things come from
 * crawlproof.com: its analytics script (cookieless) and an ad in a sandboxed cross-origin
 * frame, so the CSP needs crawlproof.com in script-src, connect-src and frame-src only.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { Audit, Check, Status } from './audit.js'
import type { Quota } from './ratelimit.js'
import { pitFooter } from './pit-footer.js'

export const SITE = 'https://seo.rank'
export const REPO = 'https://github.com/moshcoder/seo.rank'
export const LINKS = {
  repo: REPO,
  npm: 'https://www.npmjs.com/package/seorank',
  crawlproof: 'https://crawlproof.com/?utm_source=seo.rank&utm_medium=referral',
  build: 'https://pit.world/build',
  listing: 'https://pit.world/b/seo.rank',
  pit: 'https://pit.world',
}

const asset = (name: string) => {
  const body = readFileSync(new URL(`../public/${name}`, import.meta.url))
  return `/${name}?v=${createHash('sha256').update(body).digest('hex').slice(0, 10)}`
}
const STYLE_URL = asset('style.css')

/** crawlproof.com analytics: the project id it reports to. */
export const TRACKER_SITE = '1566d3ea-35d9-4fc2-bf9f-0d473f7ddc5a'
const TRACKER = `<script data-site="${TRACKER_SITE}" src="https://crawlproof.com/stats.js" async></script>`

/** A crawlproof ad, as a cross-origin sandboxed frame. CRAWLPROOF_AD_SLOT overrides the slot; 'off' turns ads off. */
export const AD_SLOT = process.env.CRAWLPROOF_AD_SLOT ?? 'b4191a7d-8931-4bfe-abc1-30e45d645fdd'
export const adUnit = (format: 'text_link' | 'banner_300x250') =>
  AD_SLOT === 'off' ? '' : `<div class="ad-unit ad-${format}"><iframe src="https://crawlproof.com/api/ads/frame?slot=${encodeURIComponent(AD_SLOT)}&amp;format=${format}" title="Advertisement" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation" scrolling="no"></iframe></div>`

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
export const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (c) => ESC[c]!)

const LOGO = `<svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><rect x="3" y="18" width="6" height="10" rx="1.5" fill="currentColor" opacity=".45"/><rect x="13" y="11" width="6" height="17" rx="1.5" fill="currentColor" opacity=".7"/><rect x="23" y="4" width="6" height="24" rx="1.5" fill="currentColor"/></svg>`

type LayoutOptions = { title: string; description: string; path: string; body: string; noindex?: boolean; pitVerify?: string }

function layout(o: LayoutOptions): string {
  const url = `${SITE}${o.path}`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)}</title>
<meta name="description" content="${esc(o.description)}">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="dark light">
<meta name="theme-color" content="#07090c">
${o.noindex ? '<meta name="robots" content="noindex">' : `<link rel="canonical" href="${esc(url)}">`}
${o.pitVerify ? `<meta name="pit-verify" content="${esc(o.pitVerify)}">\n` : ''}<meta property="og:type" content="website">
<meta property="og:site_name" content="seo.rank">
<meta property="og:title" content="${esc(o.title)}">
<meta property="og:description" content="${esc(o.description)}">
<meta property="og:url" content="${esc(url)}">
<meta name="twitter:card" content="summary">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="${STYLE_URL}">
<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'WebApplication', name: 'seo.rank', url: SITE, applicationCategory: 'SEO tool', operatingSystem: 'Any', offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' }, isAccessibleForFree: true, license: `${REPO}/blob/main/LICENSE` }).replace(/</g, '\\u003c')}</script>
${TRACKER}
</head>
<body>
<!--ring-bar-->
<header class="top"><a class="brand" href="/">${LOGO}<span>seo<b>.rank</b></span></a><nav><a href="/about">How it works</a><a href="/about#api">API · CLI · MCP</a><a href="${REPO}">GitHub</a></nav></header>
<main>
${adUnit('text_link')}
${o.body}
</main>
<footer class="foot">
  <nav>
    <span>© seo.rank</span>
    <a href="/about">How it works</a>
    <a href="/about#api">API</a>
    <a href="/about#mcp">MCP</a>
    <a href="/about#privacy">Privacy</a>
    <a href="${LINKS.repo}">Source (MIT)</a>
    <a href="${LINKS.npm}">npm</a>
  </nav>
</footer>
${pitFooter()}
</body>
</html>`
}

function quotaLine(q: Quota | null, note = ''): string {
  if (!q) return ''
  return `<p class="quota${q.remaining === 0 ? ' out' : ''}"><b>${q.remaining}</b> of ${q.limit} free audits left today${note} · resets at 00:00 UTC</p>`
}

function form(value = '', autofocus = true): string {
  return `<form class="audit-form" action="/audit" method="get" role="search">
  <label class="sr" for="u">Website address</label>
  <input id="u" name="url" type="text" inputmode="url" autocomplete="url" spellcheck="false" placeholder="example.com/page" value="${esc(value)}" required maxlength="2048"${autofocus ? ' autofocus' : ''}>
  <button type="submit">Audit</button>
</form>`
}

export function homePage(quota: Quota | null, pitVerify?: string): string {
  return layout({
    title: 'seo.rank: free on-page SEO audit',
    description: 'Audit any page for on-page SEO in seconds: title, meta description, canonical, robots, sitemap, headings, alt text, links, Open Graph, structured data, HTTPS and speed. Free, open source, with an API, CLI and MCP server.',
    path: '/',
    ...(pitVerify ? { pitVerify } : {}),
    body: `<section class="hero">
  <h1>Free on-page SEO audit</h1>
  <p class="tag">Paste a URL. Get a score and the fixes that matter most, in the order to make them.</p>
  ${form()}
  ${quotaLine(quota)}
</section>
<section class="grid3">
  <div><h2>What it checks</h2><p>Title and meta description length, canonical, robots meta, robots.txt and sitemap, the heading outline, image alt text, internal and external links, Open Graph and X cards, JSON-LD types, hreflang, HTTPS, http→https and HSTS, response time, HTML weight and compression.</p></div>
  <div><h2>What it repeats</h2><p>The words and phrases your page says most, with density, and whether the top one is in your title or H1. Usually that is the first surprise: the page is about something else than you thought.</p></div>
  <div><h2>Where you want it</h2><p>A <a href="/about#api">JSON API</a>, a CLI and TUI (<code>bunx seorank</code>), and an <a href="/about#mcp">MCP server</a> so your agent can audit pages too. Open source under MIT: <a href="${REPO}">run your own</a>, without limits.</p></div>
</section>`,
  })
}

const STATUS_LABEL: Record<Status, string> = { pass: 'Pass', warn: 'Improve', fail: 'Fix', info: 'Note' }

function ring(score: number, grade: string): string {
  const r = 52
  const c = 2 * Math.PI * r
  const dash = ((score / 100) * c).toFixed(1)
  return `<svg class="ring g-${esc(grade)}" viewBox="0 0 120 120" role="img" aria-label="Score ${score} out of 100"><circle cx="60" cy="60" r="${r}" class="track"/><circle cx="60" cy="60" r="${r}" class="bar" stroke-dasharray="${dash} ${c.toFixed(1)}" transform="rotate(-90 60 60)"/><text x="60" y="58" class="num">${score}</text><text x="60" y="82" class="grade">grade ${esc(grade)}</text></svg>`
}

function checkRow(c: Check): string {
  return `<li class="check s-${c.status}"><span class="badge">${STATUS_LABEL[c.status]}</span><div><b>${esc(c.label)}</b><span class="msg">${esc(c.message)}</span>${c.fix && c.status !== 'pass' ? `<span class="fix">${esc(c.fix)}</span>` : ''}</div></li>`
}

function ago(iso: string): string {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000)
  return m < 1 ? 'just now' : `${m} min ago`
}

export function resultsPage(o: { audit: Audit; quota: Quota | null; cached: boolean }): string {
  const a = o.audit
  const groups = [...new Set(a.checks.map((c) => c.group))]
  const terms = (list: Audit['keywords']['words']) =>
    list.length ? `<table class="terms"><thead><tr><th>Term</th><th>Count</th><th>Density</th></tr></thead><tbody>${list.map((t) => `<tr><td>${esc(t.term)}</td><td>${t.count}</td><td>${t.density}%</td></tr>`).join('')}</tbody></table>` : '<p class="muted">Not enough text.</p>'
  const outline = a.page.headings.slice(0, 60).map((h) => `<li class="h${h.level}"><span>h${h.level}</span> ${esc(h.text || '(empty)')}</li>`).join('')
  const host = new URL(a.finalUrl).hostname
  return layout({
    title: `${host} SEO audit: ${a.score}/100 · seo.rank`,
    description: `On-page SEO audit of ${a.finalUrl}: score ${a.score}/100, ${a.summary.fail} to fix, ${a.summary.warn} to improve.`,
    path: `/audit`,
    noindex: true,
    body: `<section class="again">${form(a.url, false)}${quotaLine(o.quota, o.cached ? ` (this result is from ${ago(a.fetchedAt)} and did not use one)` : '')}</section>
<section class="summary">
  ${ring(a.score, a.grade)}
  <div>
    <h1>${esc(host)}</h1>
    <p class="final"><a href="${esc(a.finalUrl)}" rel="nofollow noopener">${esc(a.finalUrl)}</a></p>
    <p class="counts"><span class="s-fail">${a.summary.fail} to fix</span> <span class="s-warn">${a.summary.warn} to improve</span> <span class="s-pass">${a.summary.pass} passed</span></p>
    <p class="muted">HTTP ${a.status} · ${a.timing.ttfbMs} ms · ${Math.round(a.bytes / 1024)} KB · ${a.page.wordCount} words${a.redirects.length ? ` · ${a.redirects.length} redirect${a.redirects.length === 1 ? '' : 's'}` : ''} · checked ${ago(a.fetchedAt)}</p>
  </div>
</section>
${a.fixes.length ? `<section class="card"><h2>Fix these first</h2><ol class="fixes">${a.fixes.map((f) => `<li class="p-${f.priority}"><span class="badge">${f.priority}</span><div><b>${esc(f.label)}</b><span>${esc(f.fix)}</span></div></li>`).join('')}</ol></section>` : '<section class="card"><h2>Nothing to fix</h2><p>Every check passed. Nice work.</p></section>'}
<section class="card">
  <h2>All checks</h2>
  ${groups.map((g) => `<h3>${esc(g)}</h3><ul class="checks">${a.checks.filter((c) => c.group === g).map(checkRow).join('')}</ul>`).join('')}
</section>
<section class="card two">
  <div><h2>Top words</h2>${terms(a.keywords.words)}</div>
  <div><h2>Top phrases</h2>${terms(a.keywords.phrases)}</div>
</section>
<section class="card">
  <h2>The page as a search engine reads it</h2>
  <dl class="facts">
    <dt>Title</dt><dd>${esc(a.page.title ?? '(none)')}</dd>
    <dt>Description</dt><dd>${esc(a.page.description ?? '(none)')}</dd>
    <dt>Canonical</dt><dd>${esc(a.page.canonical ?? '(none)')}</dd>
    <dt>Robots</dt><dd>${esc(a.page.robots ?? 'index, follow (default)')}</dd>
    <dt>robots.txt</dt><dd>${a.robotsTxt.found ? `found${a.robotsTxt.blocksPage ? ', <b class="s-fail">blocks this page</b>' : ', allows this page'}` : 'not found'}</dd>
    <dt>Sitemap</dt><dd>${a.sitemap.found ? `${esc(a.sitemap.url)} (${a.sitemap.urls}${a.sitemap.truncated ? '+' : ''} URLs)` : 'not found'}</dd>
    <dt>Structured data</dt><dd>${a.page.jsonLd.types.length ? esc(a.page.jsonLd.types.join(', ')) : a.page.microdata ? 'microdata' : '(none)'}</dd>
    <dt>Open Graph</dt><dd>${Object.keys(a.page.og).length ? esc(Object.keys(a.page.og).map((k) => `og:${k}`).join(', ')) : '(none)'}</dd>
    <dt>Images</dt><dd>${a.page.images.total} (${a.page.images.missingAlt} without alt)</dd>
    <dt>Links</dt><dd>${a.page.links.internal} internal, ${a.page.links.external} external, ${a.page.links.nofollow} nofollow</dd>
    <dt>hreflang</dt><dd>${a.page.hreflang.length ? esc(a.page.hreflang.map((h) => h.lang).join(', ')) : '(none)'}</dd>
  </dl>
  ${outline ? `<h3>Heading outline</h3><ul class="outline">${outline}</ul>` : ''}
</section>
${adUnit('banner_300x250')}
<section class="card upsell">
  <div><h2>And the AI crawlers?</h2><p>Search engines are half the story now. <a href="${LINKS.crawlproof}">CrawlProof</a> shows what ChatGPT, Claude, Perplexity and the other answer engines can actually read on this page, and tracks which bots visit.</p><p><a class="btn" href="${LINKS.crawlproof}">Check it with CrawlProof →</a></p></div>
  <div><h2>Rather have it fixed?</h2><p>Describe the site you want and <a href="${LINKS.build}">pit.world/build</a> builds it, with every check on this page passing: $49 to build, $2 a month to keep it online.</p><p><a class="btn ghost" href="${LINKS.build}">Build a site →</a></p></div>
</section>
<p class="muted small">JSON for this audit: <a href="/api/audit?url=${encodeURIComponent(a.url)}">/api/audit?url=${esc(a.url)}</a></p>`,
  })
}

export function messagePage(o: { title: string; message: string; url?: string; quota?: Quota | null; status?: string }): string {
  return layout({
    title: `${o.title} · seo.rank`,
    description: o.message,
    path: '/audit',
    noindex: true,
    body: `<section class="hero small"><h1>${esc(o.title)}</h1><p class="tag">${esc(o.message)}</p>${form(o.url ?? '')}${quotaLine(o.quota ?? null)}${
      o.status === 'limited' ? `<p class="muted">Need more? seo.rank is <a href="${REPO}">open source</a>: <code>bunx seorank audit --local example.com</code> runs the same audit on your own machine, with no limit.</p>` : ''
    }</section>`,
  })
}

export function aboutPage(): string {
  return layout({
    title: 'How seo.rank works · API, CLI, MCP',
    description: 'How the seo.rank audit works, what it costs (nothing), its free daily limit, its privacy rules, and how to use it from the API, the command line or an AI agent over MCP.',
    path: '/about',
    body: `<article class="prose">
<h1>How seo.rank works</h1>
<p>seo.rank fetches the page you give it, once, the way a crawler would: plain HTML, no JavaScript run. It also reads <code>/robots.txt</code>, looks for your XML sitemap, and checks that <code>http://</code> redirects to <code>https://</code>. Then it scores about 25 on-page checks, weighted by how much they matter to search engines, and lists the fixes in the order that moves the score most.</p>
<p>Everything runs in one small process on one box. There are no paid APIs behind it and no headless browser, which is why it can be free.</p>

<h2 id="limits">The free limit</h2>
<p>10 audits per visitor per day, and the whole site does at most a few thousand a day so it can never run up a bill. Re-opening a result from the last hour is free: audits of the same URL are kept in memory for an hour. Over the limit, the page says so and the API answers <code>429</code> with <code>Retry-After</code>.</p>
<p>No limit at all if you run it yourself: <code>bunx seorank audit --local example.com</code>, or clone <a href="${REPO}">the repo</a>.</p>

<h2 id="privacy">Privacy</h2>
<ul>
<li>No cookies and no accounts. The only script on the pages is <a href="https://crawlproof.com">CrawlProof</a>'s cookieless page-view counter, and the ads are CrawlProof ads in a sandboxed frame.</li>
<li>No access log, and the app logs nothing per request.</li>
<li>The daily limit counts an HMAC of your IP under a secret that lives only in memory and is replaced every midnight (UTC); the counts cannot be turned back into addresses.</li>
<li>The one-hour cache holds URLs and their results, nothing about who asked.</li>
</ul>

<h2 id="bot">The crawler</h2>
<p>Audits arrive with the user agent <code>Mozilla/5.0 (compatible; seorank/0.1; +https://seo.rank/about#bot)</code>. One audit is at most a handful of requests (the page, its redirects, robots.txt, a sitemap, the http check). It only fetches public addresses on ports 80 and 443, and it only fetches when a person or an agent asks it to.</p>

<h2 id="api">API</h2>
<pre>GET ${SITE}/api/audit?url=example.com
GET ${SITE}/api/quota
GET ${SITE}/health</pre>
<p><code>/api/audit</code> returns the full audit: <code>score</code>, <code>grade</code>, <code>checks[]</code> (id, group, label, status, weight, message, fix), <code>fixes[]</code> in priority order, <code>page</code> (title, description, canonical, headings, images, links, Open Graph, JSON-LD types, hreflang), <code>robotsTxt</code>, <code>sitemap</code> and <code>keywords</code>, plus your <code>quota</code>. Headers: <code>X-RateLimit-Limit</code>, <code>X-RateLimit-Remaining</code>, <code>X-RateLimit-Reset</code>. CORS is open; no key.</p>

<h2 id="cli">CLI and TUI</h2>
<pre>bun add -g seorank          # or: bunx seorank …
seorank audit example.com   # score, fixes, checks
seorank audit example.com --json
seorank audit example.com --local   # on your machine, no limit
seorank quota
seorank                     # interactive TUI</pre>
<p><code>SEORANK_URL</code> points the CLI, TUI and MCP server at another instance.</p>

<h2 id="mcp">MCP server</h2>
<pre>claude mcp add seorank -- bunx seorank mcp</pre>
<pre>{ "mcpServers": { "seorank": { "command": "bunx", "args": ["seorank", "mcp"] } } }</pre>
<p>Tools: <code>audit</code> (one URL; returns the score, prioritized fixes and every check) and <code>quota</code>. Set <code>SEORANK_LOCAL=1</code> to run audits in-process instead of through seo.rank.</p>

<h2>Source</h2>
<p>MIT licensed: <a href="${REPO}">${REPO}</a>. Bun, Hono, and Bun's built-in HTML parser.</p>
</article>`,
  })
}

export function errorPage(): string {
  return messagePage({ title: 'Something went wrong', message: 'That one is on us. Try again in a moment.' })
}
