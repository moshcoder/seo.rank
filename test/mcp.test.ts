/**
 * `seorank mcp` over real stdio, against an in-process seo.rank on a fake web: what an agent sees.
 */
import { afterAll, beforeAll, expect, it } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createApp } from '../src/server.ts'
import { fakeWeb } from './fixtures.ts'

let server: ReturnType<typeof Bun.serve>

beforeAll(() => {
  const app = createApp({ auditOptions: fakeWeb() })
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (request) => app.fetch(request, { ip: '127.0.0.9' }) })
})
afterAll(() => server.stop(true))

it('lists the tools and audits a URL', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [new URL('../bin/seorank', import.meta.url).pathname, 'mcp'],
    env: { ...process.env, SEORANK_URL: `http://127.0.0.1:${server.port}` } as Record<string, string>,
  })
  const client = new Client({ name: 'test', version: '1.0.0' })
  await client.connect(transport)
  try {
    const tools = (await client.listTools()).tools.map((t) => t.name).sort()
    expect(tools).toEqual(['audit', 'quota'])
    const r: any = await client.callTool({ name: 'audit', arguments: { url: 'good.test' } })
    expect(r.content[0].text).toContain('/100 (grade A)')
    expect(r.content[0].text).toContain('9 of 10 free seo.rank audits left today')
    const q: any = await client.callTool({ name: 'quota', arguments: {} })
    expect(JSON.parse(q.content[0].text)).toMatchObject({ limit: 10, remaining: 9 })
  } finally {
    await client.close()
  }
}, 20_000)
