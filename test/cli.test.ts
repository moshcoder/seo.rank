import { expect, it } from 'bun:test'
import { main } from '../src/cli.ts'
import { SeoRankClient, parseDnsAnswer } from '../src/client.ts'
import { createApp } from '../src/server.ts'
import { initialState, onKey } from '../src/tui.ts'
import { fakeWeb } from './fixtures.ts'

it('seorank audit prints the score and fixes from the API', async () => {
  const app = createApp({ auditOptions: fakeWeb() })
  const fake = ((input: any, init?: any) => app.fetch(new Request(String(input), init), { ip: '9.9.9.9' })) as typeof fetch
  const lines: string[] = []
  const code = await main(['audit', 'https://www.poor.test/'], { log: (t) => lines.push(t), error: (t) => lines.push(t) }, new SeoRankClient('http://127.0.0.1:1', fake))
  expect(code).toBe(0)
  const text = lines.join('\n')
  expect(text).toContain('Fix these first')
  expect(text).toContain('Page is indexable')
  expect(text).toContain('9 of 10 free audits left today')
})

it('parses a DNS wire answer with name compression', () => {
  // header (1 question, 1 answer), question seo.rank A IN, answer ptr->12, A IN ttl 60 len 4 23.95.228.174
  const q = [3, ...Buffer.from('seo'), 4, ...Buffer.from('rank'), 0, 0, 1, 0, 1]
  const msg = new Uint8Array([0, 1, 0x81, 0x80, 0, 1, 0, 1, 0, 0, 0, 0, ...q, 0xc0, 12, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 23, 95, 228, 174])
  expect(parseDnsAnswer(msg)).toEqual(['23.95.228.174'])
})

it('TUI keys: type, audit, move, quit', () => {
  const s = initialState()
  for (const ch of 'a.co') onKey(s, { name: ch, key: ch, char: ch })
  expect(s.url).toBe('a.co')
  expect(onKey(s, { name: 'enter', key: 'enter' })).toBe('audit')
  expect(onKey(s, { name: 'c', key: 'ctrl+c' })).toBe('quit')
})
