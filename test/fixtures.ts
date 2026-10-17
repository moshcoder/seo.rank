/** A fake web for tests: one good page, one poor page, robots.txt and a sitemap. */
export const GOOD = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Handmade Walnut Cutting Boards | Example Woodshop</title>
<meta name="description" content="Handmade walnut cutting boards, end grain and edge grain, finished with food-safe oil and shipped free across the United States.">
<link rel="canonical" href="https://good.test/">
<link rel="icon" href="/favicon.ico">
<link rel="alternate" hreflang="en" href="https://good.test/"><link rel="alternate" hreflang="x-default" href="https://good.test/">
<meta property="og:title" content="Walnut cutting boards"><meta property="og:description" content="Handmade."><meta property="og:image" content="https://good.test/og.png">
<meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization","name":"Example"},{"@type":"Product","name":"Board"}]}</script>
<style>h1{color:red}</style></head><body>
<h1>Walnut cutting boards &amp; more</h1>
<h2>Why walnut cutting boards</h2><p>${'Walnut cutting boards are gentle on knives and last for decades. '.repeat(30)}</p>
<h3>Care</h3><p>Oil your walnut cutting boards monthly.</p>
<img src="/a.jpg" alt="A walnut board"><img src="/b.jpg" alt="">
<a href="/shop">Shop</a> <a href="/care">Care</a> <a href="https://good.test/about">About</a> <a href="https://other.test/" rel="nofollow">Other</a>
<script>var hidden = "script words never count";</script>
</body></html>`

export const POOR = `<html><head><title>Hi</title><meta name="robots" content="noindex"></head><body><h2>One</h2><h4>Skip</h4><img src="/x.png"><img src="/y.png"><script type="application/ld+json">{bad json</script><p>Short page.</p></body></html>`

export function fakeWeb(extra: Record<string, () => Response> = {}): { fetch: typeof fetch; resolve: (h: string) => Promise<string[]>; calls: string[] } {
  const calls: string[] = []
  const routes: Record<string, () => Response> = {
    'https://good.test/': () => new Response(GOOD, { headers: { 'content-type': 'text/html; charset=utf-8', 'strict-transport-security': 'max-age=31536000', 'content-encoding': 'gzip' } }),
    'http://good.test/': () => new Response(null, { status: 301, headers: { location: 'https://good.test/' } }),
    'https://good.test/robots.txt': () => new Response('User-agent: *\nDisallow: /admin\nSitemap: https://good.test/sitemap.xml\n', { headers: { 'content-type': 'text/plain' } }),
    'https://good.test/sitemap.xml': () => new Response('<?xml version="1.0"?><urlset><url><loc>https://good.test/</loc></url><url><loc>https://good.test/shop</loc></url></urlset>', { headers: { 'content-type': 'application/xml' } }),
    'https://poor.test/': () => new Response(POOR, { headers: { 'content-type': 'text/html' } }),
    'https://www.poor.test/': () => new Response(null, { status: 301, headers: { location: 'https://poor.test/' } }),
    'https://hop.test/': () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.test/' } }),
    'https://rebind.test/': () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/' } }),
    ...extra,
  }
  const fetchImpl = (async (input: any) => {
    const url = String(input)
    calls.push(url)
    const route = routes[url]
    return route ? route() : new Response('not found', { status: 404, headers: { 'content-type': 'text/html' } })
  }) as typeof fetch
  const resolve = async (host: string) => {
    if (host === 'internal.test') return ['10.0.0.5']
    if (host === 'nx.test') throw new Error('ENOTFOUND')
    return ['93.184.216.34']
  }
  return { fetch: fetchImpl, resolve, calls }
}
