/**
 * seorank: seo.rank from the terminal.
 *
 *   seorank                         the TUI
 *   seorank audit URL [--json] [--local] [--fixes]
 *   seorank quota [--json]
 *   seorank open URL                the results page in your browser
 *   seorank mcp                     MCP server on stdio
 *   seorank serve [--port N]        run your own seo.rank
 */
import { spawn } from 'node:child_process'
import { ApiError, SeoRankClient, Unreachable } from './client.js'
import { textReport } from './report.js'

export const HELP = `seorank: free on-page SEO audits (https://seo.rank)

  seorank                        interactive audit (TUI)
  seorank audit URL              score, prioritized fixes, every check
  seorank audit URL --local      run the audit on this machine (no daily limit)
  seorank audit URL --fixes      only the fix list
  seorank quota                  free audits left today
  seorank open URL               open the results page in your browser
  seorank mcp                    MCP server on stdio: claude mcp add seorank -- seorank mcp
  seorank serve [--port N]       run your own instance

  --json                         machine-readable output
  SEORANK_URL=https://…          use another seo.rank instance
`

type Out = { log(text: string): void; error(text: string): void }

export async function main(argv: string[], out: Out = { log: (t) => console.log(t), error: (t) => console.error(t) }, client = new SeoRankClient()): Promise<number> {
  const flags = new Set(argv.filter((a) => a.startsWith('--')))
  const json = flags.has('--json')
  const args = argv.filter((a) => !a.startsWith('--') || a === '--port')
  const [command, ...words] = args

  try {
    switch (command) {
      case undefined: {
        if (flags.has('--help') || !process.stdout.isTTY) {
          out.log(HELP)
          return 0
        }
        await (await import('./tui.js')).runTui(client)
        return 0
      }
      case 'help':
      case '-h':
        out.log(HELP)
        return 0
      case 'audit':
      case 'a': {
        const target = words[0]
        if (!target) return usage(out, 'seorank audit URL [--json] [--local]')
        let result
        let note = ''
        if (flags.has('--local')) result = await (await import('./audit.js')).audit(target)
        else {
          try {
            result = await client.audit(target)
            if (result.quota) note = `${result.quota.remaining} of ${result.quota.limit} free audits left today${result.cached ? ' (cached result, did not use one)' : ''}.`
          } catch (error) {
            if (!(error instanceof Unreachable)) throw error
            out.error(`seorank: ${error.message} Running the audit locally instead.`)
            result = await (await import('./audit.js')).audit(target)
          }
        }
        if (json) out.log(JSON.stringify(result, null, 2))
        else {
          out.log(textReport(result, { checks: !flags.has('--fixes'), color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR }))
          if (note) out.log(`\n${note}`)
        }
        return 0
      }
      case 'quota': {
        const q = await client.quota()
        if (json) out.log(JSON.stringify(q, null, 2))
        else out.log(`${q.remaining} of ${q.limit} free audits left today (resets ${q.resetAt}).`)
        return 0
      }
      case 'open': {
        const target = words[0]
        if (!target) return usage(out, 'seorank open URL')
        const url = `${client.base}/audit?url=${encodeURIComponent(target)}`
        const cmd = process.platform === 'darwin' ? ['open', url] : process.platform === 'win32' ? ['cmd', '/c', 'start', '""', url] : ['xdg-open', url]
        spawn(cmd[0]!, cmd.slice(1), { detached: true, stdio: 'ignore' }).on('error', () => out.log(url)).unref()
        return 0
      }
      case 'mcp':
        await (await import('./mcp.js')).runMcp(client)
        // Serve until the client hangs up: returning would let bin/seorank exit mid-session.
        await new Promise<void>((resolve) => process.stdin.once('close', resolve))
        return 0
      case 'serve': {
        const portAt = words.indexOf('--port')
        const { serve } = await import('./server.js')
        const server = serve(portAt === -1 ? {} : { port: Number(words[portAt + 1]) })
        out.log(`seo.rank listening on http://${server.hostname}:${server.port}`)
        await new Promise(() => {})
        return 0
      }
      default:
        // `seorank example.com` is an audit.
        if (/\.|:\/\//.test(command)) return main(['audit', ...argv], out, client)
        out.error(`seorank: unknown command "${command}"\n`)
        out.log(HELP)
        return 64
    }
  } catch (error) {
    if (error instanceof ApiError && error.status === 429) out.error(`seorank: ${error.message}`)
    else out.error(`seorank: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

function usage(out: Out, text: string): number {
  out.error(`usage: ${text}`)
  return 64
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)))
