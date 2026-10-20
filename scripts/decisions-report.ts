/**
 * Decision layer usage report over ~/.memwise/logs/decisions.jsonl (and the rotated
 * decisions.prev.jsonl): calls, failures, latency and — from the outcome lines — how often
 * each feature's answer changed behaviour.
 *
 *   bun run decisions:report [--session <id>] [--feature <tag>] [--since <ISO date | 24h | 7d>]
 *                            [--provider <id>]... [--json]
 */

import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { CONFIG_DIR } from '../packages/shared/src/config/paths.ts'
import { formatDecisionUsage, readDecisionLog, summarizeDecisionUsage } from '../packages/shared/src/decisions/usage.ts'

const { values } = parseArgs({
  options: {
    session: { type: 'string' },
    feature: { type: 'string' },
    since: { type: 'string' },
    provider: { type: 'string', multiple: true },
    json: { type: 'boolean', default: false },
  },
})

function parseSince(value: string | undefined): Date | undefined {
  if (!value) return undefined
  const relative = /^(\d+)([hd])$/.exec(value)
  if (relative) return new Date(Date.now() - Number(relative[1]) * (relative[2] === 'h' ? 3_600_000 : 86_400_000))
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error(`--since: not a date or 24h/7d: ${value}`)
  return date
}

const logs = join(CONFIG_DIR, 'logs')
const lines = [...(await readDecisionLog(join(logs, 'decisions.prev.jsonl'))), ...(await readDecisionLog(join(logs, 'decisions.jsonl')))]
const summary = summarizeDecisionUsage(lines, {
  sessionId: values.session,
  feature: values.feature,
  since: parseSince(values.since),
  providers: values.provider,
})
console.log(values.json ? JSON.stringify(summary, null, 2) : formatDecisionUsage(summary))
