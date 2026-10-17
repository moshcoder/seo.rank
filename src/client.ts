/**
 * The seo.rank API, as a client. The CLI, the TUI and the MCP server all use it.
 *
 * seo.rank is a Moshpit name: it lives outside the public DNS and its certificate
 * chains to the Moshpit Root CA, not to a root your OS ships. So the client:
 *
 *   1. resolves the host with the system resolver (works if you run moshcode dns),
 *   2. falls back to the Moshpit DNS-over-HTTPS resolver (dns.moshcode.sh),
 *   3. connects to that address with SNI set to the name, and verifies the
 *      certificate against the Moshpit root bundled in this package
 *      (public/moshpit-root-ca.crt, the same file the registry publishes).
 *
 * SEORANK_URL points it at another instance; ordinary public hosts go through
 * plain fetch.
 */
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { rootCertificates } from 'node:tls'
import type { Audit } from './audit.js'

export const DEFAULT_URL = 'https://seo.rank'
export const MOSHPIT_DOH = 'https://dns.moshcode.sh/dns-query'

export type ApiAudit = Audit & { cached: boolean; quota: { limit: number; remaining: number; resetAt: string } }
export type ApiQuota = { limit: number; used: number; remaining: number; resetAt: string }

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfter: number | null = null,
  ) {
    super(message)
  }
}

/** Thrown when the instance cannot be reached at all (as opposed to answering with an error). */
export class Unreachable extends Error {}

let rootPem: string | null | undefined
async function moshpitRoot(): Promise<string | null> {
  if (rootPem !== undefined) return rootPem
  try {
    rootPem = await Bun.file(new URL('../public/moshpit-root-ca.crt', import.meta.url).pathname).text()
  } catch {
    rootPem = null
  }
  return rootPem
}

function dnsQuery(name: string): Uint8Array<ArrayBuffer> {
  const labels = name.replace(/\.$/, '').split('.')
  const parts: number[] = [0x5e, 0x0a, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]
  for (const l of labels) {
    const bytes = new TextEncoder().encode(l)
    parts.push(bytes.length, ...bytes)
  }
  parts.push(0, 0, 1, 0, 1) // root, type A, class IN
  return new Uint8Array(parts)
}

function skipName(buf: Uint8Array, at: number): number {
  while (at < buf.length) {
    const len = buf[at]!
    if (len === 0) return at + 1
    if ((len & 0xc0) === 0xc0) return at + 2
    at += len + 1
  }
  return at
}

/** The A records in a DNS wire-format answer. */
export function parseDnsAnswer(buf: Uint8Array): string[] {
  if (buf.length < 12) return []
  const qd = (buf[4]! << 8) | buf[5]!
  const an = (buf[6]! << 8) | buf[7]!
  let at = 12
  for (let i = 0; i < qd; i++) at = skipName(buf, at) + 4
  const out: string[] = []
  for (let i = 0; i < an && at + 10 <= buf.length; i++) {
    at = skipName(buf, at)
    const type = (buf[at]! << 8) | buf[at + 1]!
    const rdlen = (buf[at + 8]! << 8) | buf[at + 9]!
    at += 10
    if (type === 1 && rdlen === 4) out.push(`${buf[at]}.${buf[at + 1]}.${buf[at + 2]}.${buf[at + 3]}`)
    at += rdlen
  }
  return out
}

async function resolveMoshpit(host: string, fetchImpl: typeof fetch): Promise<string | null> {
  try {
    const r = await fetchImpl(MOSHPIT_DOH, { method: 'POST', headers: { 'content-type': 'application/dns-message', accept: 'application/dns-message' }, body: dnsQuery(host), signal: AbortSignal.timeout(6_000) })
    if (!r.ok) return null
    return parseDnsAnswer(new Uint8Array(await r.arrayBuffer()))[0] ?? null
  } catch {
    return null
  }
}

export class SeoRankClient {
  private route: Promise<{ origin: string; init: Record<string, unknown> }> | null = null

  constructor(
    readonly base = (process.env.SEORANK_URL ?? DEFAULT_URL).replace(/\/+$/, ''),
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Work out once how to reach the instance: directly, or by address with SNI. */
  private connect() {
    this.route ??= (async () => {
      const url = new URL(this.base)
      const ca = await moshpitRoot()
      const tls = url.protocol === 'https:' && ca ? { tls: { ca: [ca, ...rootCertificates] } } : {}
      if (isIP(url.hostname) || url.hostname === 'localhost') return { origin: url.origin, init: {} }
      try {
        await lookup(url.hostname)
        return { origin: url.origin, init: tls }
      } catch {}
      const ip = await resolveMoshpit(url.hostname, this.fetchImpl)
      if (!ip) throw new Unreachable(`${url.hostname} does not resolve (not in the public DNS, and the Moshpit resolver did not answer).`)
      const origin = `${url.protocol}//${ip}${url.port ? `:${url.port}` : ''}`
      return { origin, init: { headers: { host: url.host }, ...(url.protocol === 'https:' && ca ? { tls: { ca, serverName: url.hostname } } : {}) } }
    })()
    return this.route
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let route: { origin: string; init: Record<string, unknown> }
    try {
      route = await this.connect()
    } catch (error) {
      this.route = null
      throw error
    }
    let response: Response
    try {
      response = await this.fetchImpl(`${route.origin}${path}`, {
        ...route.init,
        ...init,
        headers: { accept: 'application/json', ...((route.init.headers as Record<string, string>) ?? {}), ...((init.headers as Record<string, string>) ?? {}) },
        signal: AbortSignal.timeout(45_000),
      } as RequestInit)
    } catch (error) {
      this.route = null
      throw new Unreachable(`Could not reach ${this.base}: ${error instanceof Error ? error.message : String(error)}`)
    }
    const body = (await response.json().catch(() => ({}))) as any
    if (!response.ok) {
      const retry = response.headers.get('retry-after')
      throw new ApiError(body?.error ?? `HTTP ${response.status}`, response.status, retry ? Number(retry) : null)
    }
    return body as T
  }

  audit(url: string): Promise<ApiAudit> {
    return this.request(`/api/audit?url=${encodeURIComponent(url)}`)
  }

  quota(): Promise<ApiQuota> {
    return this.request('/api/quota')
  }

  health(): Promise<{ ok: boolean; version: string }> {
    return this.request('/health')
  }
}
