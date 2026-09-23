/**
 * Plugin entry point.
 *
 * OpenCode treats *every function export* of the file it loads as a separate
 * plugin. This file therefore exports exactly one thing — the default plugin —
 * and the implementation lives in `engine.ts` (shared state machine) and
 * `v2.ts` (V2 adapter). (Shipping extra exports made opencode instantiate the
 * plugin two or three times, which wrote duplicate summaries and, for
 * non-plugin exports, crashed the hook dispatcher.)
 *
 * V1 (>= 1.18.29) loads the default export's `server` property; V2 loads
 * `setup`.
 */

import type { Plugin, PluginInput } from "@opencode-ai/plugin"
import type { Event } from "@opencode-ai/sdk"
import { extractText } from "./cut.ts"
import {
  DEFAULTS,
  createEngine,
  normalizeProviderLimits,
  sharedProviderList,
  type CacheCompactOptions,
  type Host,
} from "./engine.ts"
import { v2Setup } from "./v2.ts"

export type { CacheCompactOptions } from "./engine.ts"
export { __resetSharedState } from "./engine.ts"

export const createServer = (
  input: PluginInput,
  options: CacheCompactOptions = {},
): Awaited<ReturnType<Plugin>> => {
  const cfg = { ...DEFAULTS, ...options }
  const { client } = input

  const host: Host = {
    log(level, message, extra = {}) {
      if (level === "debug" && !cfg.debug) return
      try {
        // Also to stderr so it shows up in `docker logs paseo` when debugging.
        if (cfg.debug) {
          process.stderr.write(
            `[cache-compact] ${level} ${message} ${JSON.stringify(extra)}\n`,
          )
        }
        client.app
          ?.log?.({ body: { service: "cache-compact", level, message, extra } })
          ?.catch?.(() => {})
      } catch {
        /* never throw from logging */
      }
    },
    async sendText(sessionID, text) {
      const res: any = await client.session.prompt({
        path: { id: sessionID },
        body: { parts: [{ type: "text", text }] },
      })
      const payload = res?.data ?? res
      const info = payload?.info
      const summaryText = extractText(payload?.parts ?? [])
      if (info?.role === "assistant" && summaryText && info.parentID) {
        return { boundaryUserID: info.parentID, summaryAssistantID: info.id, text: summaryText }
      }
      return undefined
    },
    async abort(sessionID) {
      await client.session.abort({ path: { id: sessionID } })
    },
    async resolveLimit(providerID, modelID) {
      const limits = await sharedProviderList(async () =>
        normalizeProviderLimits(await client.provider.list()),
      )
      const reported = limits[providerID]?.[modelID]
      return typeof reported === "number" && reported > 0 ? reported : cfg.contextLimit!
    },
  }

  const engine = createEngine(cfg, host)

  return {
    config: async (config) => {
      if (!cfg.disablePrune) return
      const mutable = config as any
      const compaction: any = (mutable.compaction ??= {})
      if (compaction.prune === undefined) compaction.prune = false
    },

    event: async ({ event }: { event: Event }) => {
      engine.handleEvent(event.type, event.properties as any)
    },

    "chat.params": async (hookInput: any, output: any) => {
      // The step-finish part carries no provider/model; capture them here, on
      // every request, so the trip can resolve the model's context limit.
      engine.observeRequest(
        hookInput.sessionID,
        hookInput.model?.providerID,
        hookInput.model?.id,
      )
      const cap = engine.summaryCapTokens(hookInput.sessionID)
      if (cap === null) return
      const max = output.maxOutputTokens
      if (typeof max !== "number" || max > cap) {
        output.maxOutputTokens = cap
      }
      if (output.options && typeof output.options === "object") {
        output.options = {
          ...output.options,
          reasoningEffort: output.options.reasoningEffort ?? "low",
        }
      }
    },

    "experimental.chat.messages.transform": async (_hookInput, output) => {
      engine.cutIfReady(output.messages)
    },
  }
}

export const CacheCompact: Plugin = async (input, options) =>
  createServer(input, (options ?? {}) as CacheCompactOptions)

/**
 * The dual entrypoint. V1 (>= 1.18.29) detects an object on `id` and calls
 * `server`; V2 detects `id` + `setup`. Both halves must always travel together
 * — `id` without `server` throws on V1, and a function default never runs on V2.
 */
const plugin = {
  id: "opencode-cache-compact",
  setup: v2Setup,
  server: CacheCompact,
}

export default plugin
