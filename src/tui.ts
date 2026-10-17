/**
 * `seorank` with no arguments: audit from the terminal.
 *
 * Type a URL, Enter audits, ↑/↓ walk the checks (fixes first), Enter opens the
 * results page in the browser, Esc goes back to typing, Ctrl+C quits.
 */
import { spawn } from 'node:child_process'
import { createApp } from '@profullstack/hqtui'
import type { Audit, Check } from './audit.js'
import { SeoRankClient, Unreachable } from './client.js'

export type TuiState = {
  url: string
  typing: boolean
  busy: boolean
  result: (Audit & { quota?: { remaining: number; limit: number } }) | null
  local: boolean
  error: string | null
  selected: number
}

export const initialState = (): TuiState => ({ url: '', typing: true, busy: false, result: null, local: false, error: null, selected: 0 })

const ORDER = { fail: 0, warn: 1, info: 2, pass: 3 } as const
/** Checks in the order worth reading: failures and warnings by weight, then the rest. */
export function rows(result: Audit | null): Check[] {
  if (!result) return []
  return [...result.checks].sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.weight - a.weight)
}

/** Pure key handling, so it can be tested without a terminal. Returns what to do next. */
export function onKey(state: TuiState, key: { name: string; key: string; char?: string }): 'audit' | 'open' | 'quit' | null {
  if (key.key === 'ctrl+c') return 'quit'
  const count = rows(state.result).length
  if (state.typing) {
    if (key.name === 'enter') return state.url.trim() && !state.busy ? 'audit' : null
    if (key.name === 'backspace') state.url = state.url.slice(0, -1)
    else if (key.name === 'escape') {
      if (count) state.typing = false
      else return 'quit'
    } else if (key.name === 'down' && count) state.typing = false
    else if (key.char && key.char.length === 1 && !key.key.startsWith('ctrl+')) state.url += key.char
    return null
  }
  if (key.name === 'down' || key.name === 'j') state.selected = Math.min(count - 1, state.selected + 1)
  else if (key.name === 'up' || key.name === 'k') {
    if (state.selected === 0) state.typing = true
    else state.selected -= 1
  } else if (key.name === 'enter') return count ? 'open' : null
  else if (key.name === 'escape' || key.name === '/' || key.char === '/') state.typing = true
  else if (key.name === 'q') return 'quit'
  return null
}

function openUrl(url: string): void {
  if (!/^https?:\/\//i.test(url)) return
  const argv = process.platform === 'darwin' ? ['open', url] : process.platform === 'win32' ? ['cmd', '/c', 'start', '""', url] : ['xdg-open', url]
  const child = spawn(argv[0]!, argv.slice(1), { detached: true, stdio: 'ignore' })
  child.on('error', () => {})
  child.unref()
}

const MARK = { pass: '✓', warn: '!', fail: '✗', info: 'i' } as const

export async function runTui(client = new SeoRankClient()): Promise<void> {
  const state = initialState()
  const app = await createApp({ title: 'seo.rank', quitKeys: [] })

  const doAudit = async () => {
    state.busy = true
    state.error = null
    app.invalidate()
    try {
      try {
        state.result = await client.audit(state.url.trim())
        state.local = false
      } catch (error) {
        if (!(error instanceof Unreachable)) throw error
        state.result = await (await import('./audit.js')).audit(state.url.trim())
        state.local = true
      }
      state.selected = 0
      state.typing = false
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error)
    } finally {
      state.busy = false
      app.invalidate()
    }
  }

  app.on('key', (event: any) => {
    const action = onKey(state, event)
    if (action === 'quit') app.quit()
    else if (action === 'audit') void doAudit()
    else if (action === 'open' && state.result) openUrl(`${client.base}/audit?url=${encodeURIComponent(state.result.url)}`)
    app.invalidate()
  })

  app.render(({ ui, theme }: any) => {
    const r = state.result
    ui.row({ size: 1 }, (header: any) => {
      header.text(' seo.rank', { fg: theme.accent, bold: true, size: 10 })
      header.text('free on-page SEO audit', { fg: theme.muted })
      header.text(`${r?.quota ? `${r.quota.remaining}/${r.quota.limit} left today · ` : state.local ? 'local · ' : ''}${client.base.replace(/^https?:\/\//, '')} `, { fg: theme.muted, align: 'right' })
    })
    ui.panel({ title: state.typing ? 'URL (typing)' : 'URL', size: 3 }, (p: any) => p.text(`${state.url}${state.typing ? '▏' : ''}`, { fg: theme.text }))
    if (r)
      ui.panel({ title: `Score ${r.score}/100 · grade ${r.grade}`, size: 3 }, (p: any) =>
        p.text(`${r.finalUrl}   ✗ ${r.summary.fail} fix  ! ${r.summary.warn} improve  ✓ ${r.summary.pass} pass   ${r.timing.ttfbMs} ms`, { fg: r.score >= 80 ? theme.accent : theme.text }),
      )
    const list = rows(r)
    ui.panel({ title: state.busy ? 'Auditing…' : r ? 'Checks (worst first)' : 'Checks' }, (p: any) => {
      if (state.error) p.text(state.error, { fg: theme.danger ?? theme.accent })
      else if (!r) p.text('Type a URL (example.com) and press Enter.', { fg: theme.muted })
      else
        p.list({
          items: list.map((c) => ({ label: `${MARK[c.status]} ${c.label}  ${c.message}` })),
          selected: state.typing ? -1 : state.selected,
          followSelection: true,
          scrollbar: true,
        })
    })
    const sel = !state.typing ? list[state.selected] : undefined
    if (sel) ui.panel({ title: `${sel.group} · ${sel.status}`, size: 5 }, (p: any) => p.text(`${sel.message}${sel.fix && sel.status !== 'pass' ? `\nFix: ${sel.fix}` : ''}`, { fg: theme.muted }))
    ui.statusBar({
      items: state.typing
        ? [{ key: 'Enter', label: 'audit' }, { key: '↓', label: 'checks' }, { key: 'Esc', label: 'quit' }]
        : [{ key: 'Enter', label: 'open in browser' }, { key: '↑↓', label: 'move' }, { key: '/', label: 'new URL' }, { key: 'q', label: 'quit' }],
      right: [{ label: 'no cookies · open source' }],
    })
  })

  await app.start()
}
