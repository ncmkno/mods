import { costUsd } from './ledger'
import type { ApiUsage } from './ledger'

export type ReportEvent =
  | {
      type: 'usage'
      agent: string
      model: string
      input: number
      output: number
      cacheRead: number
      cacheWrite: number
      costUsd: number | null
    }
  | { type: 'tool'; agent: string; tool: string; detail?: string }
  | { type: 'agent'; agent: string; label: string; model?: string }
  | { type: 'session'; state: 'start' | 'end' | 'clear'; cwd?: string }

export type StampedEvent = ReportEvent & { id: string; v: 1; session: string; ts: number }

export const EVENTS_URL = 'http://usage-monitor/events'
export const FLUSH_MS = 500
export const TIMEOUT_MS = 15_000
export const RETRY_MIN_MS = 2000
export const RETRY_MAX_MS = 60_000
export const MAX_BATCH = 500
export const MAX_QUEUE = 2000

// The API rejects a whole batch for one string past its limit, so longer ones are cut on the wire.
const MAX_LENGTH: Record<string, number> = { session: 64, agent: 64, model: 100, tool: 200, label: 300, cwd: 4096, detail: 300 }

export const encode = (events: StampedEvent[]): string =>
  JSON.stringify({ events }, (key, value) => {
    const max = MAX_LENGTH[key]

    return typeof value === 'string' && max !== undefined ? value.slice(0, max) : value
  })

export const usageEvent = (agent: string, usage: ApiUsage & { model: string }): ReportEvent => {
  const tokens = {
    input: usage.input_tokens,
    output: usage.output_tokens,
    cacheRead: usage.cache_read_input_tokens,
    cacheWrite: usage.cache_creation_input_tokens,
  }

  return { type: 'usage', agent, model: usage.model, ...tokens, costUsd: costUsd(usage.model, tokens) ?? null }
}

// The input field that says what a call did, in order of preference.
const DETAIL_FIELDS = ['command', 'file_path', 'notebook_path', 'pattern', 'url', 'query', 'description', 'skill', 'path']
const MAX_DETAIL = 160

// Applied in order; each keeps its key and replaces the value with "…".
const REDACTIONS: [RegExp, string][] = [
  [/\b(authorization)\s*:\s*[^"'\n]*/gi, '$1: …'],
  [/\b(bearer)\s+\S+/gi, '$1 …'],
  [/([\w-]*(?:token|secret|password|passwd|pwd|api[_-]?key)[\w-]*)(\s*=\s*|\s+)("[^"]*"|'[^']*'|\S+)/gi, '$1$2…'],
  // Long unbroken runs of token characters (no "/" or ".", so paths and hostnames survive).
  [/[A-Za-z0-9_+=-]{32,}/g, '…'],
]

/**
 * A short summary of a tool call's input for the dashboard: its main field, whitespace collapsed,
 * secret-looking values redacted, cut to 160 characters. Undefined when there is nothing to show.
 */
export function toolDetail(input: Record<string, unknown>): string | undefined {
  const field = DETAIL_FIELDS.find(key => typeof input[key] === 'string' && input[key].trim() !== '')
  if (field === undefined) {
    return undefined
  }

  const text = REDACTIONS.reduce((s, [pattern, by]) => s.replace(pattern, by), String(input[field]).replace(/\s+/g, ' ').trim())

  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL - 1)}…` : text
}
