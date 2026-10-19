import { expect, it } from 'bun:test'
import { createApp } from '../src/server.js'
import { pitFooter, setPitFooter, startPitFooterRefresh } from '../src/pit-footer.js'

it('pit.world footer: nothing until read, then the last thing in <body>, kept on failure', async () => {
  expect(setPitFooter('<p>not the footer</p>')).toBe(false)
  expect(pitFooter()).toBe('')
  const frag = '<style>.pit-foot{}</style><nav class="pit-foot" data-pit-footer>x</nav>'
  const stop = startPitFooterRefresh('seo.rank', (async (url: string) => {
    expect(url).toBe('https://pit.world/snippets/footer.html?site=seo.rank')
    return new Response(frag)
  }) as unknown as typeof fetch)
  await new Promise((r) => setTimeout(r, 10))
  stop()
  const html = await (await createApp({}).request('/')).text()
  expect(html.match(/data-pit-footer/g)?.length).toBe(1)
  expect(html).toMatch(/<\/footer>[\s\S]*data-pit-footer[\s\S]*<\/nav>\s*<\/body>/)
  // The Profullstack ring footer is server-rendered (the verifier never runs script), before the global footer, with no ad in it.
  const ring = html.indexOf('https://rssamplifier.com/ring/profullstack/next?from=https%3A%2F%2Fseo.rank.pit.world%2F')
  expect(ring).toBeGreaterThan(-1)
  expect(ring).toBeLessThan(html.indexOf('data-pit-footer'))
  expect(html.slice(html.indexOf('</main>'))).not.toContain('crawlproof.com/api/ads')
  const stop2 = startPitFooterRefresh('seo.rank', (async () => { throw new Error('down') }) as unknown as typeof fetch)
  await new Promise((r) => setTimeout(r, 10))
  stop2()
  expect(pitFooter()).toContain('data-pit-footer')
})
