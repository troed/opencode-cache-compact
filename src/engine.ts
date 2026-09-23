/**
 * The version-agnostic compaction engine.
 *
 * Everything that decides *what happens* on a threshold trip lives here: the
 * shared cross-instance state, the trip/summarize/resume sequence, the event
 * handlers, and the cut decision. Version-specific concerns (how to send a
 * turn, abort, list provider limits, log) arrive through the Host seam, so the
 * V1 adapter (plugin.ts) and the V2 adapter (v2.ts) cannot drift.
 */

import { cutMessages, type AnyMessage } from "./cut.ts"
import type { AssistantMessage } from "@opencode-ai/sdk"

export type CacheCompactOptions = {
  /** Percent of the model's context that trips the summary. Default 68. */
  threshold?: number
  /** Hard cap on summary output tokens. Default 1200. */
  summaryMaxTokens?: number
  /** Fallback context window if the provider reports none. Default 131072. */
  contextLimit?: number
  /** Override the summary instruction sent as a user turn. */
  summaryPrompt?: string
  /** Only act on these models, as `providerID/modelID`. Empty = all models. */
  models?: string[]
  /**
   * After the summary is written, send a short user turn so the cut is applied
   * immediately and work continues on the compacted context. Without this the
   * cut only lands on the next message a human sends. Default true.
   */
  autoResume?: boolean
  /** The turn sent when `autoResume` fires. Default "Continue from where you left off." */
  resumePrompt?: string
  /**
   * Abort the in-flight turn when the threshold is crossed, so the summary is
   * written mid-run instead of waiting for a long agentic turn to end (which can
   * overshoot the limit). Default true.
   */
  abortOnTrip?: boolean
  /** Milliseconds to let an abort settle before summarizing. Default 300. */
  abortSettleMs?: number
  /** Turn off OpenCode's `compaction.prune` (it mutates history and breaks cache). V1-only; default true. */
  disablePrune?: boolean
  /** Verbose debug logging. Default false. */
  debug?: boolean
}

export const DEFAULTS = {
  threshold: 68,
  summaryMaxTokens: 1200,
  contextLimit: 131072,
  autoResume: true,
  abortOnTrip: true,
  abortSettleMs: 300,
  disablePrune: true,
  debug: false,
} as const

export const DEFAULT_RESUME_PROMPT = "Continue from where you left off."

export const DEFAULT_SUMMARY_PROMPT = `You are about to run out of context. Stop working on the task and write a complete handoff summary of this session so work can continue seamlessly from it in a fresh context.

Do not call any tools. Do not ask questions. Reply with the summary only.

Capture, as compactly as possible while keeping every specific that matters:
- The user's objective and any stated constraints or preferences.
- Key decisions and the reasoning behind them.
- Files created or changed, with paths, and what changed.
- The current state of the work and what is in progress.
- Errors or dead ends encountered and how they were resolved.
- The precise next steps.

Prefer concrete details (paths, commands, identifiers, versions) over generalities.`

type SessionState = {
  /** A summary request is in flight; do not trip again. */
  pending: boolean
  /** The user turn that requested the summary (becomes the cut boundary). */
  boundaryUserID?: string
  /** The assistant message holding the summary. */
  summaryAssistantID?: string
  /** Suppress re-trips until this timestamp. */
  cooldownUntil: number
  /** Exact context size of the most recent normal step (provider usage). */
  lastUsed: number
  lastProviderID?: string
  lastModelID?: string
}

/** Per-provider, per-model context windows as reported by the provider list. */
export type ProviderLimits = Record<string, Record<string, number | undefined>>

/**
 * Normalize either adapter's `provider.list` payload into ProviderLimits.
 * Tolerates the V1 envelope (`{ data: { all: [...] } }`), a bare array, and
 * V2 provider records (`{ provider: { id }, models: Map }`).
 */
export function normalizeProviderLimits(raw: unknown): ProviderLimits {
  const body = raw as any
  const all: any[] = Array.isArray(body) ? body : (body?.data?.all ?? body?.all ?? [])
  const out: ProviderLimits = {}
  for (const entry of all ?? []) {
    if (!entry || typeof entry !== "object") continue
    const id =
      typeof entry.id === "string"
        ? entry.id
        : typeof entry.provider?.id === "string"
          ? entry.provider.id
          : undefined
    if (!id) continue
    const src =
      entry.models instanceof Map
        ? Object.fromEntries(entry.models as Map<string, unknown>)
        : (entry.models ?? {})
    const models: Record<string, number | undefined> = {}
    for (const [modelID, model] of Object.entries(src as Record<string, unknown>)) {
      const context = (model as any)?.limit?.context
      models[modelID] = typeof context === "number" ? context : undefined
    }
    out[id] = models
  }
  return out
}

/**
 * OpenCode instantiates a plugin more than once in the same process (observed:
 * twice). If each copy kept its own state, both would trip on the same event and
 * write two summaries and two resumes. Share one registry across copies, keyed
 * by session id.
 */
const shared = {
  states: new Map<string, SessionState>(),
  limitCache: new Map<string, number>(),
  providerListPromise: undefined as Promise<ProviderLimits> | undefined,
}

/** Test-only: clear the cross-instance registry. */
export function __resetSharedState(): void {
  shared.states.clear()
  shared.limitCache.clear()
  shared.providerListPromise = undefined
}

/** One shared, memoized provider-limit fetch across plugin copies. */
export function sharedProviderList(
  fetch: () => Promise<ProviderLimits>,
): Promise<ProviderLimits> {
  if (!shared.providerListPromise) {
    shared.providerListPromise = Promise.resolve()
      .then(fetch)
      .catch(() => ({}) as ProviderLimits)
  }
  return shared.providerListPromise
}

export type LogLevel = "debug" | "info" | "warn" | "error"

/** Normalized summary turn: the boundary user message and the reply holding the summary. */
export type SummaryResult = {
  boundaryUserID: string
  summaryAssistantID: string
  text: string
}

/** The entire V1/V2 seam — every version-specific call the engine needs. */
export interface Host {
  log(level: LogLevel, message: string, extra?: Record<string, unknown>): void
  /** Send a user turn. Returns the summary when the reply carried usable text, else undefined. */
  sendText(sessionID: string, text: string): Promise<SummaryResult | undefined>
  /** Stop the in-flight turn (V1 `session.abort` / V2 `session.interrupt`). */
  abort(sessionID: string): Promise<void>
  /** Final context window for a model: provider-reported or cfg.contextLimit. */
  resolveLimit(providerID: string, modelID: string): Promise<number>
}

export type Engine = {
  /** Feed every event here: V1 from the `event` hook, V2 from `ctx.event.subscribe`. */
  handleEvent(type: string, props: any): void
  /** Record the model in use for a session (every request, both adapters). */
  observeRequest(sessionID: string, providerID?: string, modelID?: string): void
  /** Output-token cap iff a summary is pending, else null. */
  summaryCapTokens(sessionID: string): number | null
  /** Apply the cut to an outgoing message list; returns messages removed. */
  cutIfReady(messages: unknown, sessionID?: string): number
}

let instanceCounter = 0

/**
 * Exact context size from opencode: `tokens.total` is the provider's
 * `total_tokens` (prompt + completion) for the request. Fall back to summing
 * the parts only if a provider omits it.
 */
const sumTokens = (t: any): number => {
  if (!t) return 0
  if (typeof t.total === "number" && t.total > 0) return t.total
  return (
    (t.input ?? 0) +
    (t.output ?? 0) +
    (t.reasoning ?? 0) +
    (t.cache?.read ?? 0) +
    (t.cache?.write ?? 0)
  )
}

export function createEngine(cfg: CacheCompactOptions, host: Host): Engine {
  const states = shared.states
  const instanceId = ++instanceCounter
  host.log("debug", "plugin instance created", { instanceId })

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

  const ensureState = (sessionID: string): SessionState => {
    let state = states.get(sessionID)
    if (!state) {
      state = { pending: false, cooldownUntil: 0, lastUsed: 0 }
      states.set(sessionID, state)
    }
    return state
  }

  /** Append the summary turn. Returns true when a usable summary was written. */
  const summarize = async (sessionID: string): Promise<boolean> => {
    const result = await host.sendText(sessionID, cfg.summaryPrompt ?? DEFAULT_SUMMARY_PROMPT)
    if (result) {
      const state = ensureState(sessionID)
      state.boundaryUserID = result.boundaryUserID
      state.summaryAssistantID = result.summaryAssistantID
      host.log("info", "summary written; cutting context from now on", {
        sessionID,
        summaryChars: result.text.length,
      })
      return true
    }
    host.log("warn", "summary response was empty; not cutting", { sessionID })
    return false
  }

  /**
   * Stop whatever turn is running, take a summary, then resume. Aborting is what
   * lets this fire mid-run: OpenCode only emits `session.idle` at the end of a
   * whole turn, and a long agentic turn can otherwise run from 70% to 100%.
   */
  const trip = async (sessionID: string): Promise<void> => {
    const state = ensureState(sessionID)
    if (state.pending) return
    state.pending = true
    let ok = false
    try {
      if (cfg.abortOnTrip) {
        try {
          await host.abort(sessionID)
        } catch {
          /* nothing running — fine */
        }
        if (cfg.abortSettleMs! > 0) await sleep(cfg.abortSettleMs!)
      }
      ok = await summarize(sessionID)
    } catch (error) {
      host.log("error", "summary request failed", { sessionID, error: String(error) })
    } finally {
      state.lastUsed = 0
      state.cooldownUntil = Date.now() + (ok ? 30_000 : 60_000)
      state.pending = false
    }
    if (ok && cfg.autoResume) {
      try {
        await host.sendText(sessionID, cfg.resumePrompt ?? DEFAULT_RESUME_PROMPT)
      } catch (error) {
        host.log("error", "resume prompt failed", { sessionID, error: String(error) })
      }
    }
  }

  const maybeTrip = (sessionID: string): void => {
    const state = states.get(sessionID)
    if (!state || state.pending) return
    if (Date.now() < state.cooldownUntil) return
    const { lastUsed, lastProviderID, lastModelID } = state
    if (lastUsed <= 0 || !lastProviderID || !lastModelID) return
    if (cfg.models?.length && !cfg.models.includes(`${lastProviderID}/${lastModelID}`)) return
    void (async () => {
      const key = `${lastProviderID}/${lastModelID}`
      let limit = shared.limitCache.get(key)
      if (limit === undefined) {
        limit = await host.resolveLimit(lastProviderID!, lastModelID!)
        shared.limitCache.set(key, limit)
      }
      if (lastUsed < limit * (cfg.threshold! / 100)) return
      const current = states.get(sessionID)
      if (!current || current.pending || Date.now() < current.cooldownUntil) return
      host.log("info", "context threshold reached; summarizing", {
        sessionID,
        used: lastUsed,
        limit,
        threshold: cfg.threshold,
      })
      await trip(sessionID)
    })()
  }

  const onAssistantMessage = (info: AssistantMessage): void => {
    // OpenCode's own compaction summaries and our summary reply both report the
    // pre-cut token count; never let them re-trip.
    if (info.summary || info.error) return
    // `time.completed` is only set when the *whole turn* ends, but a step's
    // usage lands at `step-finish`, which sets `finish`. Requiring `completed`
    // made the trigger wait for the turn to end — too late for a long agentic
    // turn, which can overflow the context before it ever idles.
    if (!info.finish && !info.time?.completed) return

    const state = ensureState(info.sessionID)
    if (state.pending || info.id === state.summaryAssistantID) return

    const used = sumTokens(info.tokens)
    if (used <= 0) return
    state.lastUsed = used
    state.lastProviderID = info.providerID
    state.lastModelID = info.modelID
    // Fire immediately: a long agentic turn never goes idle, so waiting for
    // `session.idle` lets the context overshoot the threshold.
    maybeTrip(info.sessionID)
  }

  /**
   * The reliable mid-turn signal: every step emits a `step-finish` part carrying
   * the exact usage. `message.updated` at step level does not always reach
   * plugins, but `message.part.updated` does.
   */
  const onStepFinish = (part: any): void => {
    const used = sumTokens(part?.tokens)
    if (used <= 0) return
    const state = ensureState(part.sessionID)
    if (state.pending || part.messageID === state.summaryAssistantID) return
    state.lastUsed = used
    host.log("debug", "step-finish", {
      sessionID: part.sessionID,
      used,
      reason: part.reason,
    })
    maybeTrip(part.sessionID)
  }

  const handleEvent = (type: string, props: any): void => {
    if (type === "message.part.updated") {
      const part = props?.part
      if (part?.type === "step-finish") onStepFinish(part)
      return
    }
    if (type === "message.updated") {
      const info = props?.info
      if (info?.role === "assistant") onAssistantMessage(info)
      return
    }
    if (type === "session.idle") {
      // Fallback: message.updated already fires this, but idle catches the
      // case where the last assistant message never completed.
      maybeTrip(props?.sessionID)
      return
    }
    if (type === "session.deleted") {
      const id = props?.info?.id
      if (id) states.delete(id)
    }
  }

  const observeRequest = (
    sessionID: string,
    providerID?: string,
    modelID?: string,
  ): void => {
    const state = ensureState(sessionID)
    if (providerID) state.lastProviderID = providerID
    if (modelID) state.lastModelID = modelID
  }

  const summaryCapTokens = (sessionID: string): number | null => {
    const state = states.get(sessionID)
    return state?.pending ? cfg.summaryMaxTokens ?? null : null
  }

  const cutIfReady = (messages: unknown, sessionID?: string): number => {
    const list = messages as AnyMessage[] | undefined
    if (!Array.isArray(list) || list.length === 0) return 0
    const sid = sessionID ?? (list[0]?.info as any)?.sessionID
    if (!sid) return 0
    const state = states.get(sid)
    if (!state?.boundaryUserID || !state.summaryAssistantID) return 0
    const removed = cutMessages(list, state.boundaryUserID, state.summaryAssistantID)
    if (removed > 0) {
      host.log("debug", "cut outgoing context", {
        sessionID: sid,
        removed,
        remaining: list.length,
      })
    }
    return removed
  }

  return { handleEvent, observeRequest, summaryCapTokens, cutIfReady }
}
