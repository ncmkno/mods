import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { UsageLedger, UsageRow } from '../types'
import {
  MAIN,
  addToolCall,
  addUsage,
  cacheHitPercent,
  compact,
  emptyLedger,
  modelText,
  setLabel,
  setSpawnModel,
  statusText,
  subagentIds,
  tokenLine,
  toolCount,
  totals,
  usd,
} from './ledger'
import {
  EVENTS_URL,
  FLUSH_MS,
  MAX_BATCH,
  MAX_QUEUE,
  RETRY_MAX_MS,
  RETRY_MIN_MS,
  TIMEOUT_MS,
  encode,
  toolDetail,
  usageEvent,
} from './report'
import type { ReportEvent, StampedEvent } from './report'

const PANE = 'usage-monitor'
const MAX_AGENTS = 12
const MAX_TOOLS = 15

const ledger = atom({ plugin: 'usage-monitor', key: 'ledger' } as const, emptyLedger())

const publish = ($: EngineInterface, next: UsageLedger) =>
  $.ui.status(Object.keys(next.rows).length === 0 ? undefined : statusText(next))

const shorten = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

// The reporter lives here, not in ./report: $ may only be passed to functions declared in this file.
const queue: StampedEvent[] = []
let isBusy = false
let retryMs = RETRY_MIN_MS

async function send($: EngineInterface, socket: string, events: StampedEvent[]) {
  const stop = new AbortController()
  const timeout = $.clock
    .sleep(TIMEOUT_MS, { signal: stop.signal })
    .then(() => Promise.reject(new Error('usage-monitor API timed out')))

  try {
    const request = $.http.fetch(EVENTS_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: encode(events),
      socketPath: socket,
    })

    return await Promise.race([request, timeout])
  } finally {
    stop.abort()
  }
}

async function flush($: EngineInterface, socket: string) {
  const batch = queue.splice(0, MAX_BATCH)
  let delay = FLUSH_MS

  // A 4xx means the API refused the contract: that batch is dropped, never retried.
  const isDone = await send($, socket, batch).then(
    response => response.status < 500,
    () => false,
  )

  if (isDone) {
    retryMs = RETRY_MIN_MS
  } else {
    queue.unshift(...batch)
    queue.splice(0, Math.max(0, queue.length - MAX_QUEUE))
    delay = retryMs
    retryMs = Math.min(retryMs * 2, RETRY_MAX_MS)
  }

  isBusy = false

  if (queue.length > 0) {
    schedule($, socket, delay)
  }
}

// One flush is waiting or running at a time; the next is scheduled when it ends.
function schedule($: EngineInterface, socket: string, ms: number) {
  if (isBusy) {
    return
  }

  $.clock.after(ms, () => void flush($, socket).catch(() => {}))
  isBusy = true
}

async function enqueue($: EngineInterface, socket: string, event: ReportEvent, session: string | undefined) {
  const ts = Date.now()
  const id = session ?? (await $.session.id())

  queue.push({ ...event, id: crypto.randomUUID(), v: 1, session: id, ts })
  queue.splice(0, Math.max(0, queue.length - MAX_QUEUE))
  schedule($, socket, FLUSH_MS)
}

/**
 * Queues an event in memory and POSTs queued events to the usage-monitor API over its Unix
 * socket. Does nothing when `socket` is empty. A hook never waits on it: this only starts
 * work, and every failure is swallowed. `session` is the session's id when the event is
 * about one that is not the current one.
 */
function report($: EngineInterface, socket: string, event: ReportEvent, session?: string) {
  if (socket !== '') {
    void enqueue($, socket, event, session).catch(() => {})
  }
}

export const register: Register = (on, options) => {
  const socket = String(options.apiSocket ?? '')

  on('session.start', async ($, e, next) => {
    report($, socket, { type: 'session', state: 'start', cwd: e.cwd })
    await $.command.register({
      name: 'usage-monitor',
      description: 'Token, cost and tool-call usage per subagent (add "reset" to zero the counters)',
    })
    publish($, await read($, ledger))

    return next(e)
  })

  on('command.run', { command: 'usage-monitor' }, async ($, e) => {
    if (e.args.trim() === 'reset') {
      publish($, await update($, ledger, emptyLedger))

      return { text: 'Usage counters reset.' }
    }

    await $.ui.open({ id: PANE, title: 'Usage' })

    return { text: 'Usage pane opened.' }
  })

  on('session.end', async ($, e, next) => {
    report($, socket, { type: 'session', state: e.reason === 'clear' ? 'clear' : 'end' }, e.sessionId)

    if (e.reason === 'clear') {
      await update($, ledger, emptyLedger)
      $.ui.status(undefined)
    }

    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    const id = spawned.agentId

    if (id !== undefined) {
      const who = e.name === undefined ? e.subagentType : `${e.name} (${e.subagentType})`

      await update($, ledger, l => setSpawnModel(setLabel(l, id, `${who}: ${e.description}`), id, spawned.model))
      report($, socket, { type: 'agent', agent: id, label: `${who}: ${e.description}`, model: spawned.model })
    }

    return spawned
  })

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const usage = result.usage

    if (usage !== null) {
      publish($, await update($, ledger, l => addUsage(l, e.agentId ?? MAIN, usage.model, usage)))
      report($, socket, usageEvent(e.agentId ?? MAIN, usage))
    }

    return result
  })

  on('tool.call', async ($, e, next) => {
    publish($, await update($, ledger, l => addToolCall(l, e.agentId ?? MAIN, String(e.tool))))
    const detail = toolDetail(e as unknown as Record<string, unknown>)
    report($, socket, { type: 'tool', agent: e.agentId ?? MAIN, tool: String(e.tool), ...(detail === undefined ? {} : { detail }) })

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const id = e.agentId

    if (id !== undefined) {
      const agent = (await $.agent.list()).find(a => a.id === id)
      const row = (await read($, ledger)).rows[id]
      const label = row?.label ?? (agent === undefined ? undefined : `${agent.type}: ${agent.description}`)

      if (row !== undefined && label !== undefined) {
        $.ui.toast(`${shorten(label, 44)} · ${modelText(row)} · ${toolCount(row)} tools · ${tokenLine(row)}`, {
          timeoutMs: 8000,
        })
      }
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const l = await read($, ledger)
    const [agents, session] = await Promise.all([$.agent.list(), $.session.usage()])
    const all = totals(l)
    const main = l.rows[MAIN]
    const byId = new Map(agents.map(a => [a.id, a]))
    const subs = subagentIds(l).sort((a, b) => (l.rows[b]?.costUsd ?? 0) - (l.rows[a]?.costUsd ?? 0))
    const tools = Object.entries(all.tools).sort((a, b) => b[1] - a[1])
    const mainTools = main === undefined ? 0 : toolCount(main)

    const block = (key: string, label: string, status: string, row: UsageRow) => (
      <Box key={key} flexDirection="column" marginTop={1}>
        <Box>
          <Text bold>{shorten(label, 48)}</Text>
          <Text dimColor> {status}</Text>
          <Text color="cyan"> {modelText(row)}</Text>
        </Box>
        <Text>
          {'  '}
          {tokenLine(row)}
        </Text>
        <Text dimColor>
          {'  '}
          {toolCount(row)} tools · {row.requests} requests
        </Text>
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Text bold>Session</Text>
        <Text>
          new {compact(all.tokens.input)} · cache reads {compact(all.tokens.cacheRead)} · written{' '}
          {compact(all.tokens.cacheWrite)} · out {compact(all.tokens.output)}
        </Text>
        <Text>
          cache hit {cacheHitPercent(all.tokens)}% · est. {usd(all.costUsd)}
          {session.cost === undefined ? '' : ` · session total ${usd(session.cost.usd)}`}
        </Text>
        <Text>
          {toolCount(all)} tool calls (main {mainTools} · subagents {toolCount(all) - mainTools})
        </Text>
        {all.unpricedModels.length > 0 && (
          <Text color="yellow">no list price for {all.unpricedModels.join(', ')}; cost excludes it</Text>
        )}

        {main !== undefined && block(MAIN, 'Main thread', '', main)}

        {subs.length > 0 && (
          <Box marginTop={1}>
            <Text bold>Subagents ({subs.length})</Text>
          </Box>
        )}
        {subs.slice(0, MAX_AGENTS).map(id => {
          const agent = byId.get(id)
          const row = l.rows[id] as UsageRow
          const label =
            row.label ??
            (agent === undefined ? `subagent ${id.slice(0, 8)}` : `${agent.type}: ${agent.description}`)

          return block(id, label, agent?.status ?? 'finished', row)
        })}
        {subs.length > MAX_AGENTS && <Text dimColor>+{subs.length - MAX_AGENTS} more</Text>}

        {tools.length > 0 && (
          <Box marginTop={1}>
            <Text bold>Tool calls</Text>
          </Box>
        )}
        {tools.slice(0, MAX_TOOLS).map(([tool, n]) => {
          const inSubagents = n - (main?.tools[tool] ?? 0)

          return (
            <Text>
              {shorten(tool, 34).padEnd(34)} {String(n).padStart(4)}
              {inSubagents > 0 ? `  (${inSubagents} in subagents)` : ''}
            </Text>
          )
        })}
        {tools.length > MAX_TOOLS && <Text dimColor>+{tools.length - MAX_TOOLS} more tools</Text>}

        <Box marginTop={1} flexDirection="column">
          <Text dimColor>cache reads = the context re-read from cache on every request, summed</Text>
          <Text dimColor>est. = list price × tokens; cache writes at the 5-minute rate (1.25×)</Text>
        </Box>
      </Box>
    )
  })
}
