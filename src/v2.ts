/**
 * OpenCode V2 adapter.
 *
 * V2 registers hooks instead of returning them: one event subscription feeds
 * the shared engine, and a single `session` `"context"` hook observes each
 * outgoing request (model capture, summary caps, cut). All version-specific
 * calls live in the Host below.
 */

import { messageText } from "./cut.ts"
import {
  DEFAULTS,
  DEFAULT_SUMMARY_PROMPT,
  createEngine,
  normalizeProviderLimits,
  sharedProviderList,
  type CacheCompactOptions,
  type Host,
  type SummaryResult,
} from "./engine.ts"

/** The slice of the request-time context hook event this adapter uses. */
export type V2ContextEvent = {
  sessionID: string
  model?: { providerID?: string; id?: string }
  options: Record<string, unknown> & { maxTokens?: number; reasoningEffort?: string }
  messages?: unknown
}

/** The slice of the V2 plugin context this adapter uses (structural — no V2 runtime import). */
export type V2Ctx = {
  options?: CacheCompactOptions
  app?: {
    log?(input: { body: Record<string, unknown> }): Promise<unknown> | unknown
  }
  event: {
    subscribe(options: { signal: AbortSignal }): AsyncIterable<{
      type?: string
      data?: unknown
      properties?: unknown
    }>
  }
  session: {
    hook(
      name: "context",
      callback: (event: V2ContextEvent) => void | Promise<void>,
    ): Promise<{ dispose?: unknown }>
    prompt(input: { sessionID: string; text: string }): Promise<unknown>
    wait(input: { sessionID: string }): Promise<unknown>
    context(input: { sessionID: string }): Promise<unknown>
    interrupt(input: { sessionID: string; continue?: boolean }): Promise<unknown>
  }
  provider: {
    list(): Promise<unknown>
  }
  /** V2 keeps per-model context limits here; the provider list has none. */
  model?: {
    list(): Promise<unknown>
  }
}

const infoOf = (m: any): any => m?.info ?? m

/** How long to wait for the summary turn to finish before giving up (never cuts on a hang). */
export const SUMMARY_REPLY_TIMEOUT_MS = 120_000

/**
 * Race `promise` against a timeout: resolves `{ ok: true, value }` when the
 * promise settles first, `{ ok: false }` when the timeout wins. A later
 * rejection of `promise` still has a handler attached, so a hung-then-failed
 * wait can never surface as an unhandled rejection.
 */
function raceTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<{ ok: true; value: T } | { ok: false }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ ok: false }), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve({ ok: true, value })
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/** The admitted request message id, when the prompt return exposes one. */
function idFromPromptReturn(res: unknown): string | undefined {
  const r = res as any
  if (typeof r?.id === "string") return r.id
  if (typeof r?.messageID === "string") return r.messageID
  if (typeof r?.info?.id === "string") return r.info.id
  return undefined
}

/**
 * V2 `session.prompt` does not return the assistant reply like V1 did: admit the
 * turn, wait for it to finish, then read `session.context`. Two shapes occur:
 * classic `{info, parts}` (with `parentID`) and flat V2 `{id, type, text|
 * content}` (no parent links; a `{type:"idle"}` marker trails the reply).
 * Guards: scan back past non-conversation noise but stop at a user turn (a
 * missing reply must never let a stale assistant masquerade as the summary);
 * classic replies must be the admitted request's child; flat replies must sit
 * after the admitted request. No anchor or no text => undefined (never cuts).
 */
function summaryFromMessages(raw: unknown, requestID?: string): SummaryResult | undefined {
  const messages: any[] = Array.isArray(raw) ? raw : ((raw as any)?.data ?? [])
  const roleOf = (m: any): unknown => infoOf(m)?.role ?? m?.type
  let idx = messages.length - 1
  while (idx >= 0) {
    const role = roleOf(messages[idx])
    if (role === "assistant") break
    if (role === "user") return undefined
    idx--
  }
  if (idx < 0) return undefined
  const reply = messages[idx]
  const text = messageText(reply)
  if (!text) return undefined
  const replyID = infoOf(reply)?.id
  if (typeof replyID !== "string") return undefined

  const parentID = infoOf(reply)?.parentID
  if (typeof parentID === "string") {
    if (requestID !== undefined && parentID !== requestID) return undefined
    if (!messages.some((m) => infoOf(m)?.id === parentID)) return undefined
    return { boundaryUserID: parentID, summaryAssistantID: replyID, text }
  }
  if (requestID === undefined) return undefined
  const reqIdx = messages.findIndex((m) => infoOf(m)?.id === requestID)
  if (reqIdx < 0 || reqIdx >= idx) return undefined
  return { boundaryUserID: requestID, summaryAssistantID: replyID, text }
}

/**
 * V2's public bus has no `message.updated` / `message.part.updated` /
 * `session.idle`; the shared engine speaks that V1 vocabulary. Map the V2
 * session events onto it — per-step token usage lives on `session.step.ended`
 * (`{sessionID, assistantMessageID, finish, tokens}`). Unknown types pass
 * through untouched; the engine ignores what it does not know.
 */
function toEngineEvent(
  type: string,
  payload: unknown,
): [type: string, props: unknown] {
  const data = payload as Record<string, unknown> | undefined
  if (type === "session.step.ended") {
    return ["message.part.updated", {
      part: {
        type: "step-finish",
        sessionID: data?.sessionID,
        messageID: data?.assistantMessageID,
        reason: data?.finish,
        tokens: data?.tokens,
      },
    }]
  }
  if (
    type === "session.execution.succeeded" ||
    type === "session.execution.failed" ||
    type === "session.execution.interrupted"
  ) {
    return ["session.idle", { sessionID: data?.sessionID }]
  }
  if (type === "session.deleted") {
    return ["session.deleted", { info: { id: data?.sessionID } }]
  }
  return [type, payload]
}

export const v2Setup = async (ctx: V2Ctx): Promise<() => void> => {
  // Ground truth for "did the loader call setup" — unconditional, because the
  // host log channel depends on ctx.app.log availability and debug plumbing.
  process.stderr.write("[cache-compact] v2 setup starting\n")
  const cfg: CacheCompactOptions = { ...DEFAULTS, ...(ctx.options ?? {}) }

  // The exact text the engine sends for the summary turn (same cfg object, so
  // same value) — used to tell summary turns apart from resume turns below.
  const summaryPrompt = cfg.summaryPrompt ?? DEFAULT_SUMMARY_PROMPT

  const host: Host = {
    log(level, message, extra = {}) {
      if (level === "debug" && !cfg.debug) return
      try {
        if (cfg.debug) {
          process.stderr.write(
            `[cache-compact] ${level} ${message} ${JSON.stringify(extra)}\n`,
          )
        }
        const appLog = ctx.app?.log
        if (typeof appLog === "function") {
          const ret = appLog.call(ctx.app, {
            body: { service: "cache-compact", level, message, extra },
          }) as { catch?: (fn: () => void) => unknown } | undefined
          ret?.catch?.(() => {})
        }
      } catch {
        /* never throw from logging */
      }
    },
    async sendText(sessionID, text) {
      const admitted = await ctx.session.prompt({ sessionID, text })
      // The engine routes both the summary prompt and the auto-resume prompt
      // through sendText; only the summary's reply is read back. Waiting for
      // the resume turn would stall this trip for the whole (potentially
      // long) resumed turn, so non-summary turns are fire-and-forget after
      // admission.
      if (text !== summaryPrompt) return undefined
      const requestID = idFromPromptReturn(admitted)
      // A wait that never settles would leave `pending` stuck true and silence
      // every future trip — bound it and treat a hang as "no summary".
      const waited = await raceTimeout(
        ctx.session.wait({ sessionID }),
        SUMMARY_REPLY_TIMEOUT_MS,
      )
      if (!waited.ok) {
        host.log("warn", "timed out waiting for the summary reply", { sessionID })
        return undefined
      }
      const raw = await ctx.session.context({ sessionID })
      const summary = summaryFromMessages(raw, requestID)
      if (!summary && cfg.debug) {
        // Extraction failed: surface the real payload shape for diagnosis.
        process.stderr.write(
          "[cache-compact] summary extraction failed; payload: " +
            JSON.stringify({ requestID, admitted, raw }).slice(0, 6000) +
            "\\n",
        )
      }
      return summary
    },
    async abort(sessionID) {
      await ctx.session.interrupt({ sessionID, continue: false })
    },
    async resolveLimit(providerID, modelID) {
      const limits = await sharedProviderList(async () => {
        // V2's provider list carries no model limits; `model.list` does
        // (`{providerID, modelID, limit: {context}}` entries). Merge both,
        // model.list winning, so V1-tolerant normalization still applies.
        const base = normalizeProviderLimits(await ctx.provider.list())
        if (!ctx.model) return base
        const list: any = await ctx.model.list()
        const models: any[] = Array.isArray(list)
          ? list
          : (list?.data ?? list?.data?.all ?? [])
        for (const m of models) {
          const pid = m?.providerID
          const mid = m?.modelID ?? m?.id
          const limit = m?.limit?.context
          if (
            typeof pid === "string" &&
            typeof mid === "string" &&
            typeof limit === "number" &&
            limit > 0
          ) {
            ;(base[pid] ??= {})[mid] = limit
          }
        }
        return base
      })
      const reported = limits[providerID]?.[modelID]
      return typeof reported === "number" && reported > 0 ? reported : cfg.contextLimit!
    },
  }

  const engine = createEngine(cfg, host)

  const controller = new AbortController()
  void (async () => {
    try {
      for await (const ev of ctx.event.subscribe({ signal: controller.signal })) {
        // V2 envelopes have used both `data` and `properties`; accept either,
        // then map V2 session.* names onto the engine's V1 vocabulary.
        const raw = String(ev?.type ?? "")
        const [type, props] = toEngineEvent(raw, ev?.data ?? ev?.properties)
        host.log("debug", "event received", { type: raw, mapped: type })
        engine.handleEvent(type, props)
      }
    } catch (err) {
      // A dead feed is an invisible failure — surface it unless we aborted.
      if (!controller.signal.aborted) {
        host.log("error", "event subscription failed", { error: String(err) })
        process.stderr.write("[cache-compact] event subscription died: " + String(err) + "\n")
      }
    }
  })()

  try {
    await ctx.session.hook("context", (event) => {
    host.log("debug", "context hook fired", { sessionID: event.sessionID })
    engine.observeRequest(event.sessionID, event.model?.providerID, event.model?.id)
    const cap = engine.summaryCapTokens(event.sessionID)
    if (cap !== null && event.options && typeof event.options === "object") {
      const max = event.options.maxTokens
      if (typeof max !== "number" || max > cap) event.options.maxTokens = cap
      event.options.reasoningEffort = event.options.reasoningEffort ?? "low"
    }
    host.log("debug", "context messages shape", {
      first: Object.keys((event.messages as any)?.[0] ?? {}),
      count: Array.isArray(event.messages) ? event.messages.length : -1,
    })
      engine.cutIfReady(event.messages, event.sessionID)
    })
  } catch (error) {
    process.stderr.write("[cache-compact] context hook registration failed: " + String(error) + "\n")
    throw error
  }

  process.stderr.write("[cache-compact] v2 setup complete\n")

  host.log("info", "v2 setup complete", { debug: cfg.debug, threshold: cfg.threshold })

  return () => controller.abort()
}
