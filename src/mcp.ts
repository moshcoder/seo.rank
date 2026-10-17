/**
 * `seorank mcp`: seo.rank as an MCP server on stdio, so an agent can audit pages.
 *
 *   claude mcp add seorank -- bunx seorank mcp
 *
 * Audits go through seo.rank (free daily limit) unless SEORANK_LOCAL=1, which runs
 * them in this process with no limit. If seo.rank cannot be reached at all, the
 * audit runs locally rather than failing.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { audit as localAudit, type Audit } from './audit.js'
import { SeoRankClient, Unreachable } from './client.js'
import { textReport } from './report.js'
import { VERSION } from './version.js'

export function createMcpServer(client = new SeoRankClient(), local = process.env.SEORANK_LOCAL === '1'): McpServer {
  // Typed loosely: the SDK's generic tool() signature recurses past TypeScript's
  // instantiation depth with zod shapes. The shapes are still validated at runtime.
  const server: any = new McpServer({ name: 'seo.rank', version: VERSION })

  server.tool(
    'audit',
    'On-page SEO audit of one URL: fetches the page, robots.txt and sitemap, and checks title, meta description, canonical, indexability, headings, image alt text, links, Open Graph, structured data (JSON-LD), hreflang, HTTPS/HSTS, response time, HTML size and the most repeated keywords. Returns a 0-100 score, the fixes in priority order, and every check.',
    { url: z.string().min(3).max(2048).describe('The page to audit, e.g. example.com or https://example.com/pricing'), format: z.enum(['text', 'json']).optional().describe('text (default): a readable report; json: the full audit object') },
    async ({ url, format }: { url: string; format?: 'text' | 'json' }) => {
      try {
        let result: Audit
        let note = ''
        if (local) result = await localAudit(url)
        else {
          try {
            const r = await client.audit(url)
            result = r
            note = r.quota ? `\n\n(${r.quota.remaining} of ${r.quota.limit} free seo.rank audits left today; SEORANK_LOCAL=1 runs them locally with no limit.)` : ''
          } catch (error) {
            if (!(error instanceof Unreachable)) throw error
            result = await localAudit(url)
            note = '\n\n(seo.rank was unreachable, so this audit ran locally.)'
          }
        }
        const text = format === 'json' ? JSON.stringify(result, null, 2) : `${textReport(result)}${note}`
        return { content: [{ type: 'text', text }] }
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] }
      }
    },
  )

  server.tool('quota', 'How many free seo.rank audits this connection has left today, and when they reset.', {}, async () => {
    if (local) return { content: [{ type: 'text', text: 'SEORANK_LOCAL=1: audits run locally, with no limit.' }] }
    try {
      return { content: [{ type: 'text', text: JSON.stringify(await client.quota(), null, 2) }] }
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] }
    }
  })

  return server
}

export async function runMcp(client = new SeoRankClient()): Promise<void> {
  await createMcpServer(client).connect(new StdioServerTransport())
}
