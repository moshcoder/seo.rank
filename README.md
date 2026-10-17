# seo.rank

**A free, open-source on-page SEO audit.** Paste a URL, get a 0–100 score and the fixes that matter most, in the order to make them. Web app, JSON API, CLI, TUI and an MCP server for AI agents.

[seo.rank](https://seo.rank) is a [Moshpit](https://pit.world/connect) site. It is listed on pit.world at [pit.world/b/seo.rank](https://pit.world/b/seo.rank).

```bash
# the CLI and TUI
bunx seorank audit example.com
bunx seorank audit example.com --local   # on your machine, no daily limit
bunx seorank                             # interactive

# your agent
claude mcp add seorank -- bunx seorank mcp
```

## What it checks

About 25 checks, weighted by how much they matter to search engines:

| Group | Checks |
| --- | --- |
| Crawlability | HTTP status, `noindex` (meta and `X-Robots-Tag`), robots.txt (does it block this page for Googlebot?), XML sitemap, canonical |
| Security | HTTPS, http→https redirect, HSTS |
| Content | title length, meta description length, one H1, heading outline, word count, whether the most repeated phrase is in the title or H1, image alt coverage, internal links |
| Mobile & markup | viewport, `lang`, charset, favicon |
| Social & rich results | Open Graph, X/Twitter card, JSON-LD types (and broken JSON-LD), hreflang |
| Speed | time to first byte, HTML size, compression |

Plus the top words and two-to-three word phrases on the page, with density.

The score is the weighted share of checks passed (a warning earns half). The fix list is sorted by what each fix is worth.

## How it stays free

- **No paid APIs, no headless browser.** One audit is a handful of HTTP requests (the page, robots.txt, a sitemap, the http check) and a few milliseconds of parsing with Bun's built-in HTMLRewriter.
- **10 audits per visitor per day**, enforced on the server. A visitor is an HMAC of their IP under a secret held only in memory and replaced at every UTC midnight, when the counts reset.
- **A global cap** (2,000 fresh audits a day by default) as a cost circuit breaker, and at most 8 audits in flight at once.
- **A one-hour cache** per URL; re-opening a recent result does not use an audit.
- Over the limit: the page says so, the API answers `429` with `Retry-After`. Or run it yourself with `--local`, without limits.

## Privacy

No cookies (the server strips `Set-Cookie` from every response), no accounts, no analytics, no JavaScript on the pages, no third-party requests. nginx keeps no access log for the site and the app logs nothing per request. Strict CSP, `Referrer-Policy: no-referrer`.

## Safe fetching

seo.rank fetches URLs that strangers give it, so `src/fetch.ts` only fetches http(s) on ports 80/443, refuses credentials in URLs, checks that every address a name resolves to is public (no loopback, RFC 1918, link-local, CGNAT, ULA, multicast, v4-mapped or NAT64 forms of those), follows at most five redirects by hand and re-checks every hop, only lets the page redirect within its own site, and enforces a timeout and a 2 MB cap.

## API

| | |
| --- | --- |
| `GET /api/audit?url=example.com` (or `POST {"url": …}`) | the full audit: `score`, `grade`, `checks[]`, `fixes[]`, `page`, `robotsTxt`, `sitemap`, `keywords`, `cached`, `quota` |
| `GET /api/quota` | `{ limit, used, remaining, resetAt }` |
| `GET /health` | `{ ok, version, today }` |

Headers `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`. CORS open, no key.

## Surfaces

The house rule: everything ships a TUI, a CLI, an MCP and an API.

| | |
| --- | --- |
| Web + API | `bun src/server.ts` (`PORT`, default 8790; `SEORANK_DAILY_LIMIT`, `SEORANK_GLOBAL_DAILY_CAP`, `SEORANK_CONCURRENCY`, `PIT_VERIFY`) |
| CLI | `seorank audit URL [--json] [--local] [--fixes]`, `seorank quota`, `seorank open URL`, `seorank serve` |
| TUI | `seorank` |
| MCP | `seorank mcp`: tools `audit` (url, format text/json) and `quota`. `SEORANK_LOCAL=1` runs audits in-process |

The CLI, TUI and MCP server talk to `https://seo.rank` (or `SEORANK_URL`). Because seo.rank is a Moshpit name, the client resolves it with your system resolver if you are on the Moshpit network, otherwise through the Moshpit DNS-over-HTTPS resolver, and verifies the certificate against the Moshpit Root CA bundled in the package (`public/moshpit-root-ca.crt`). If the instance cannot be reached at all, the CLI and MCP server run the audit locally.

### MCP config

```json
{ "mcpServers": { "seorank": { "command": "bunx", "args": ["seorank", "mcp"] } } }
```

## Run your own

```bash
git clone https://github.com/moshcoder/seo.rank && cd seo.rank
bun install
bun src/server.ts        # http://127.0.0.1:8790
bun test
```

Production runs on bare metal with `bin/install.sh` ([OpenInstall](https://logicsrc.com/openinstall)): a systemd unit running bun behind nginx.

## More

- What AI crawlers and answer engines can read on a page: [CrawlProof](https://crawlproof.com).
- A site built for you, with every check passing: [pit.world/build](https://pit.world/build).

## License

MIT
