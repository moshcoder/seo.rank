/**
 * Fetching somebody else's page on their say-so, without becoming a proxy into
 * this box's network.
 *
 * - http and https only, on the default ports, no credentials in the URL
 * - every address the name resolves to must be public (no loopback, RFC 1918,
 *   link-local, CGNAT, multicast, documentation or ULA ranges, v4-mapped included)
 * - redirects are followed by hand, at most five, and every hop is checked again;
 *   the page itself may only redirect within the same site (www and http→https allowed)
 * - a hard timeout and a byte cap on the body; anything bigger is cut off and marked
 *
 * The name is resolved twice (here, then by fetch), so a hostile DNS server could in
 * principle answer differently the second time. Both lookups go through the box's
 * caching resolver within milliseconds, which makes that window very small; it is
 * written down here rather than pretended away.
 */
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export const USER_AGENT = 'Mozilla/5.0 (compatible; seorank/0.1; +https://seo.rank/about#bot)'

export class FetchRefused extends Error {}

export type Fetched = {
  url: string
  status: number
  headers: Headers
  body: string
  bytes: number
  truncated: boolean
  ttfbMs: number
  totalMs: number
  redirects: { url: string; status: number }[]
}

export type FetchOptions = {
  timeoutMs?: number
  maxBytes?: number
  maxRedirects?: number
  /** Only follow redirects that stay on the same site as the first URL. */
  sameSite?: boolean
  fetch?: typeof fetch
  /** Tests swap the resolver; production uses the system one. */
  resolve?: (host: string) => Promise<string[]>
}

function v4Parts(ip: string): number[] | null {
  const parts = ip.split('.').map(Number)
  return parts.length === 4 && parts.every((p) => Number.isInteger(p) && p >= 0 && p <= 255) ? parts : null
}

function publicV4(ip: string): boolean {
  const p = v4Parts(ip)
  if (!p) return false
  const [a, b, c] = p as [number, number, number, number]
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false
  if (a === 100 && b >= 64 && b <= 127) return false // CGNAT
  if (a === 169 && b === 254) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false
  if (a === 198 && (b === 18 || b === 19)) return false
  if (a === 198 && b === 51 && c === 100) return false
  if (a === 203 && b === 0 && c === 113) return false
  return true
}

function expandV6(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]!
  // A dotted v4 tail (::ffff:1.2.3.4) becomes two hextets.
  const tail = s.match(/(\d+\.\d+\.\d+\.\d+)$/)
  if (tail) {
    const p = v4Parts(tail[1]!)
    if (!p) return null
    s = s.slice(0, -tail[1]!.length) + `${((p[0]! << 8) | p[1]!).toString(16)}:${((p[2]! << 8) | p[3]!).toString(16)}`
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0
  const all = [...head, ...Array(Math.max(0, fill)).fill('0'), ...rest]
  if (all.length !== 8) return null
  const out = all.map((h) => parseInt(h, 16))
  return out.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? out : null
}

function publicV6(ip: string): boolean {
  const h = expandV6(ip)
  if (!h) return false
  const embedded = () => `${h[6]! >> 8}.${h[6]! & 255}.${h[7]! >> 8}.${h[7]! & 255}`
  if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) return publicV4(embedded()) // ::ffff:v4
  if (h[0] === 0x64 && h[1] === 0xff9b) return publicV4(embedded()) // NAT64
  if (h.slice(0, 6).every((x) => x === 0)) return false // ::, ::1, v4-compatible
  if ((h[0]! & 0xfe00) === 0xfc00) return false // ULA
  if ((h[0]! & 0xffc0) === 0xfe80) return false // link-local
  if ((h[0]! & 0xff00) === 0xff00) return false // multicast
  if (h[0] === 0x2001 && h[1] === 0x0db8) return false // documentation
  if (h[0] === 0x0100 && h[1] === 0 && h[2] === 0 && h[3] === 0) return false // discard
  return true
}

export function isPublicAddress(ip: string): boolean {
  const bareIp = ip.replace(/^\[|\]$/g, '')
  const kind = isIP(bareIp)
  if (kind === 4) return publicV4(bareIp)
  if (kind === 6) return publicV6(bareIp)
  return false
}

const systemResolve = async (host: string) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address)

/** Throws FetchRefused unless the URL is one we are willing to fetch. */
export async function assertFetchable(raw: string | URL, resolve = systemResolve): Promise<URL> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new FetchRefused('That is not a valid URL.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new FetchRefused('Only http and https URLs can be audited.')
  if (url.username || url.password) throw new FetchRefused('URLs with a username or password are not audited.')
  if (url.port && url.port !== '80' && url.port !== '443') throw new FetchRefused('Only the standard ports (80 and 443) are audited.')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (!host.includes('.') && !isIP(host)) throw new FetchRefused('That host is not a public website.')
  if (/(^|\.)(local|localhost|internal|lan|home|corp|intranet|arpa)$/i.test(host)) throw new FetchRefused('That host is not a public website.')
  let addresses: string[]
  if (isIP(host)) addresses = [host]
  else {
    try {
      addresses = await resolve(host)
    } catch {
      throw new FetchRefused(`${host} does not resolve.`)
    }
  }
  if (!addresses.length) throw new FetchRefused(`${host} does not resolve.`)
  if (!addresses.every(isPublicAddress)) throw new FetchRefused('That address is not on the public internet.')
  return url
}

const bare = (host: string) => host.toLowerCase().replace(/^www\./, '')
export const sameSite = (a: URL, b: URL) => bare(a.hostname) === bare(b.hostname)

async function readCapped(response: Response, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!response.body) return { bytes: new Uint8Array(), truncated: false }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (size + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - size))
      size = maxBytes
      truncated = true
      await reader.cancel().catch(() => {})
      break
    }
    chunks.push(value)
    size += value.byteLength
  }
  const out = new Uint8Array(size)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.byteLength
  }
  return { bytes: out, truncated }
}

function decode(bytes: Uint8Array, contentType: string | null): string {
  const charset = contentType?.match(/charset=["']?([\w-]+)/i)?.[1]
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

/** Fetch a public URL under the rules above. Network failures throw FetchRefused; HTTP errors return. */
export async function safeFetch(raw: string, options: FetchOptions = {}): Promise<Fetched> {
  const { timeoutMs = 10_000, maxBytes = 2_000_000, maxRedirects = 5, fetch: fetchImpl = fetch, resolve = systemResolve } = options
  const started = performance.now()
  const signal = AbortSignal.timeout(timeoutMs)
  const first = await assertFetchable(raw, resolve)
  let url = first
  const redirects: Fetched['redirects'] = []
  for (let hop = 0; ; hop++) {
    let response: Response
    try {
      // threatcrush-disable-next-line js-ssrf-outbound-request  user-supplied URL by design (it is an SEO audit); assertFetchable allows public addresses on ports 80/443 only, every redirect hop is re-checked, with a timeout and a byte cap
      response = await fetchImpl(url.href, {
        redirect: 'manual',
        signal,
        headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5', 'accept-language': 'en;q=0.9,*;q=0.5' },
      })
    } catch (error) {
      if ((error as Error)?.name === 'TimeoutError' || signal.aborted) throw new FetchRefused(`${url.hostname} did not answer within ${Math.round(timeoutMs / 1000)} seconds.`)
      throw new FetchRefused(`Could not connect to ${url.hostname}.`)
    }
    const ttfbMs = Math.round(performance.now() - started)
    const location = response.headers.get('location')
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel().catch(() => {})
      redirects.push({ url: url.href, status: response.status })
      if (hop >= maxRedirects) throw new FetchRefused('Too many redirects.')
      let next: URL
      try {
        next = new URL(location, url)
      } catch {
        throw new FetchRefused('The page redirects to an invalid URL.')
      }
      if (options.sameSite && !sameSite(first, next)) throw new FetchRefused(`The page redirects off-site, to ${next.hostname}. Audit that URL instead.`)
      url = await assertFetchable(next, resolve)
      continue
    }
    let body: { bytes: Uint8Array; truncated: boolean }
    try {
      body = await readCapped(response, maxBytes)
    } catch {
      if (signal.aborted) throw new FetchRefused(`${url.hostname} did not finish sending the page within ${Math.round(timeoutMs / 1000)} seconds.`)
      throw new FetchRefused(`${url.hostname} stopped sending the page.`)
    }
    return {
      url: url.href,
      status: response.status,
      headers: response.headers,
      body: decode(body.bytes, response.headers.get('content-type')),
      bytes: body.bytes.byteLength,
      truncated: body.truncated,
      ttfbMs,
      totalMs: Math.round(performance.now() - started),
      redirects,
    }
  }
}
