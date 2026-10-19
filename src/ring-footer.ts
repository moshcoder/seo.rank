/**
 * seo.rank's footer: its links, the << Profullstack >> webring nav and the
 * copyright line, from @profullstack/footer. It is rendered into the HTML on the
 * server because rssamplifier's ring verifier reads the page and never runs script.
 *
 * Pages render synchronously, so the footer is kept as a string: the bundled
 * template at boot, then the @latest template from the CDN, refreshed every 15
 * minutes (a footer release reaches us with no redeploy). A failed refresh keeps
 * the last good copy. Our CSP allows inline styles, so the template CSS stays on.
 */
import { footerHtml, footerHtmlSync } from '@profullstack/footer'

type FooterOptions = Parameters<typeof footerHtmlSync>[0]

export function ringFooterOptions(links: { label: string; href: string }[]): FooterOptions {
  return {
    site: 'https://seo.rank.pit.world/',
    links,
    since: 2026,
    tagline: 'MIT',
  }
}

let options: FooterOptions | null = null
let html = ''

export function setRingFooterOptions(next: FooterOptions): void {
  options = next
  html = footerHtmlSync(next)
}

/** The footer markup, never empty once options are set. */
export function ringFooter(): string {
  return html
}

/** Accept a rendered footer only when it still links the ring. */
export function setRingFooter(next: unknown): boolean {
  if (typeof next !== 'string' || !next.includes('/ring/profullstack') || next.length > 64_000) return false
  html = next
  return true
}

export function startRingFooterRefresh(everyMs = 15 * 60_000): () => void {
  const run = () => {
    if (!options) return
    footerHtml(options).then(setRingFooter, () => {})
  }
  run()
  const timer = setInterval(run, everyMs)
  ;(timer as { unref?: () => void }).unref?.()
  return () => clearInterval(timer)
}
