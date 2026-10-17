/** Plain-text renderings of an audit, shared by the CLI and the MCP server. */
import type { Audit } from './audit.js'

const MARK = { pass: '✓', warn: '!', fail: '✗', info: 'i' } as const

export function textReport(a: Audit, options: { checks?: boolean; color?: boolean } = {}): string {
  const c = options.color
    ? { red: (s: string) => `\x1b[31m${s}\x1b[0m`, yellow: (s: string) => `\x1b[33m${s}\x1b[0m`, green: (s: string) => `\x1b[32m${s}\x1b[0m`, dim: (s: string) => `\x1b[2m${s}\x1b[0m`, bold: (s: string) => `\x1b[1m${s}\x1b[0m` }
    : { red: (s: string) => s, yellow: (s: string) => s, green: (s: string) => s, dim: (s: string) => s, bold: (s: string) => s }
  const paint = (status: keyof typeof MARK, s: string) => (status === 'pass' ? c.green(s) : status === 'warn' ? c.yellow(s) : status === 'fail' ? c.red(s) : c.dim(s))
  const lines: string[] = []
  lines.push(`${c.bold(`${a.score}/100 (grade ${a.grade})`)}  ${a.finalUrl}`)
  lines.push(c.dim(`HTTP ${a.status} · ${a.timing.ttfbMs} ms · ${Math.round(a.bytes / 1024)} KB · ${a.page.wordCount} words · ${a.summary.fail} to fix, ${a.summary.warn} to improve, ${a.summary.pass} passed`))
  if (a.fixes.length) {
    lines.push('', c.bold('Fix these first'))
    a.fixes.forEach((f, i) => lines.push(`${String(i + 1).padStart(2)}. [${f.priority}] ${f.label}: ${f.fix}`))
  } else lines.push('', 'Nothing to fix: every check passed.')
  if (options.checks !== false) {
    lines.push('', c.bold('Checks'))
    for (const ch of a.checks) lines.push(`  ${paint(ch.status, MARK[ch.status])} ${ch.label}: ${c.dim(ch.message)}`)
  }
  const kw = a.keywords.phrases.length ? a.keywords.phrases : a.keywords.words
  if (kw.length) lines.push('', `${c.bold('Top phrases')}: ${kw.slice(0, 8).map((t) => `${t.term} (${t.count})`).join(', ')}`)
  return lines.join('\n')
}
