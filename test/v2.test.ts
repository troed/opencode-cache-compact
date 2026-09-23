import { test, beforeEach } from "node:test"
import assert from "node:assert/strict"

import { SUMMARY_REPLY_TIMEOUT_MS, v2Setup, type V2Ctx } from "../src/v2.ts"
import { __resetSharedState } from "../src/engine.ts"
import plugin from "../src/plugin.ts"

beforeEach(() => __resetSharedState())

type Call = { name: string; args: any }

const settle = () => new Promise((resolve) => setTimeout(resolve, 10))
const promptsOf = (calls: Call[]) => calls.filter((c) => c.name === "prompt")

/** Single-consumer pushable async event feed matching ctx.event.subscribe. */
function makeEventFeed() {
  const queue: any[] = []
  let notify: (() => void) | undefined
  let ended = false
  const wake = () => {
    const n = notify
    notify = undefined
    n?.()
  }
  return {
    push(ev: any) {
      queue.push(ev)
      wake()
    },
    end() {
      ended = true
      wake()
    },
    subscribe({ signal }: { signal: AbortSignal }) {
      return {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<any>> {
              for (;;) {
                if (signal.aborted || ended) return { done: true, value: undefined }
                if (queue.length > 0) return { done: false, value: queue.shift() }
                await new Promise<void>((resolve) => {
                  notify = resolve
                })
              }
            },
          }
        },
      }
    },
  }
}

const SUMMARY_MESSAGES = [
  { info: { id: "u1", role: "user", sessionID: "s1" }, parts: [{ type: "text", text: "task" }] },
  {
    info: { id: "sum_req", role: "user", sessionID: "s1" },
    parts: [{ type: "text", text: "please summarize" }],
  },
  {
    info: { id: "sum", role: "assistant", sessionID: "s1", parentID: "sum_req" },
    parts: [{ type: "text", text: "MY SUMMARY" }],
  },
]

function makeV2Ctx(
  opts: {
    options?: Record<string, unknown>
    promptGate?: Promise<void>
    promptReturn?: unknown
    contextMessages?: () => any[]
    hangWait?: boolean
    interruptImpl?: () => Promise<void>
  } = {},
) {
  const calls: Call[] = []
  const feed = makeEventFeed()
  let contextHook: ((event: any) => void) | undefined

  const ctx: V2Ctx = {
    options: opts.options as any,
    app: { log: async (input: any) => void calls.push({ name: "app.log", args: input }) },
    event: { subscribe: (o) => feed.subscribe(o) },
    session: {
      hook: async (name, cb) => {
        calls.push({ name: "hook", args: name })
        if (name === "context") contextHook = cb as (event: any) => void
        return { dispose() {} }
      },
      prompt: async (input) => {
        calls.push({ name: "prompt", args: input })
        if (opts.promptGate) await opts.promptGate
        return opts.promptReturn ?? {}
      },
      wait: async (input) => {
        calls.push({ name: "wait", args: input })
        if (opts.hangWait) return new Promise<never>(() => {})
      },
      context: async (input) => {
        calls.push({ name: "context", args: input })
        return opts.contextMessages?.() ?? []
      },
      interrupt: async (input) => {
        calls.push({ name: "interrupt", args: input })
        if (opts.interruptImpl) await opts.interruptImpl()
      },
    },
    provider: {
      list: async () => ({
        data: { all: [{ id: "p", models: { m: { limit: { context: 10_000 } } } }] },
      }),
    },
  }

  return {
    ctx,
    calls,
    feed,
    takeContextHook(): (event: any) => void {
      if (!contextHook) throw new Error("context hook not registered")
      return contextHook
    },
  }
}

/** `message.updated` envelope uses `properties` (V1-style) — pins the fallback path. */
const assistantUpdated = (overrides: Record<string, unknown> = {}) => ({
  type: "message.updated",
  properties: {
    info: {
      role: "assistant",
      sessionID: "s1",
      id: "a1",
      providerID: "p",
      modelID: "m",
      time: { completed: 1 },
      tokens: { input: 8_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      ...overrides,
    },
  },
})

const TRIP_OPTIONS = { threshold: 50, abortSettleMs: 0 }

test("trips on a completed assistant turn: interrupts, summarizes, resumes", async () => {
  const h = makeV2Ctx({
    options: { ...TRIP_OPTIONS },
    contextMessages: () => SUMMARY_MESSAGES,
  })
  const cleanup = await v2Setup(h.ctx)
  assert.equal(typeof cleanup, "function")

  h.feed.push(assistantUpdated())
  await settle()

  const interrupts = h.calls.filter((c) => c.name === "interrupt")
  const prompts = promptsOf(h.calls)
  assert.equal(interrupts.length, 1)
  assert.equal(interrupts[0]!.args.sessionID, "s1")
  assert.equal(interrupts[0]!.args.continue, false)
  assert.equal(prompts.length, 2, "summary prompt + resume prompt")
  assert.match(prompts[0]!.args.text, /handoff summary/i)
  assert.match(prompts[1]!.args.text, /continue from where you left off/i)
  assert.equal(h.calls.filter((c) => c.name === "wait").length, 1, "summary waits for the turn")
  assert.equal(h.calls.filter((c) => c.name === "context").length, 1, "summary reads messages")
})

test("does not resume when the summary reply has no text", async () => {
  const h = makeV2Ctx({
    options: { ...TRIP_OPTIONS },
    contextMessages: () => [
      { info: { id: "u1", role: "user", sessionID: "s1" }, parts: [{ type: "text", text: "task" }] },
      {
        info: { id: "sum", role: "assistant", sessionID: "s1", parentID: "u1" },
        parts: [],
      },
    ],
  })
  await v2Setup(h.ctx)

  h.feed.push(assistantUpdated())
  await settle()

  const prompts = promptsOf(h.calls)
  assert.equal(prompts.length, 1, "summary sent, but no resume without a usable summary")
})

test("does not act on models outside the allow-list (V2)", async () => {
  const h = makeV2Ctx({
    options: { ...TRIP_OPTIONS, models: ["other/x"] },
    contextMessages: () => SUMMARY_MESSAGES,
  })
  await v2Setup(h.ctx)

  h.feed.push(assistantUpdated()) // providerID p / modelID m — not listed
  await settle()

  assert.equal(promptsOf(h.calls).length, 0)
})

test("still summarizes when interrupt rejects", async () => {
  const h = makeV2Ctx({
    options: { ...TRIP_OPTIONS, autoResume: false },
    contextMessages: () => SUMMARY_MESSAGES,
    interruptImpl: async () => {
      throw new Error("nothing running")
    },
  })
  await v2Setup(h.ctx)

  h.feed.push(assistantUpdated())
  await settle()

  const prompts = promptsOf(h.calls)
  assert.equal(prompts.length, 1, "a rejecting interrupt must not wedge the trip")
  assert.match(prompts[0]!.args.text, /handoff summary/i)
})

test("two setup copies share state: exactly one trip", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const a = makeV2Ctx({ options: { ...TRIP_OPTIONS, autoResume: false }, promptGate: gate, contextMessages: () => SUMMARY_MESSAGES })
  const b = makeV2Ctx({ options: { ...TRIP_OPTIONS, autoResume: false }, contextMessages: () => SUMMARY_MESSAGES })
  await v2Setup(a.ctx)
  await v2Setup(b.ctx)

  a.feed.push(assistantUpdated())
  // Let the trip reach its gated prompt (pending = true).
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  // Same event arrives at the second copy while the first trip is pending.
  b.feed.push(assistantUpdated())
  await settle()

  release()
  await settle()

  const total = promptsOf([...a.calls, ...b.calls]).length
  assert.equal(total, 1, "shared state must suppress the duplicate trip")
})

test("cleanup aborts the event subscription", async () => {
  const h = makeV2Ctx({ options: { ...TRIP_OPTIONS }, contextMessages: () => SUMMARY_MESSAGES })
  const cleanup = await v2Setup(h.ctx)

  cleanup()
  h.feed.push(assistantUpdated())
  await settle()

  assert.equal(promptsOf(h.calls).length, 0, "events after cleanup must not trip")
})


/** `message.part.updated` envelope uses `data` (the other tolerated shape). */
const stepFinish = () => ({
  type: "message.part.updated",
  data: {
    part: {
      type: "step-finish",
      sessionID: "s1",
      messageID: "a1",
      reason: "tool-calls",
      tokens: { total: 8_000, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  },
})

test("trips mid-turn on a step-finish part after the context hook observed the model", async () => {
  const h = makeV2Ctx({ options: { ...TRIP_OPTIONS, autoResume: false }, contextMessages: () => SUMMARY_MESSAGES })
  await v2Setup(h.ctx)

  // Step-finish parts carry no provider/model — the context hook captures them.
  h.takeContextHook()({
    sessionID: "s1",
    model: { providerID: "p", id: "m" },
    options: {},
    messages: [],
  })
  h.feed.push(stepFinish())
  await settle()

  assert.equal(promptsOf(h.calls).length, 1)
})

test("caps summary options while pending and preserves presets (V2)", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const h = makeV2Ctx({
    options: { ...TRIP_OPTIONS, summaryMaxTokens: 500, autoResume: false },
    promptGate: gate,
    contextMessages: () => SUMMARY_MESSAGES,
  })
  await v2Setup(h.ctx)

  h.feed.push(assistantUpdated())
  // Let the detached trip reach its gated prompt (pending = true).
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))

  const hook = h.takeContextHook()
  const draft = {
    sessionID: "s1",
    model: { providerID: "p", id: "m" },
    options: { maxTokens: 9_999 } as Record<string, unknown>,
    messages: [],
  }
  hook(draft)
  assert.equal(draft.options.maxTokens, 500)
  assert.equal(draft.options.reasoningEffort, "low")

  const preset = {
    sessionID: "s1",
    model: { providerID: "p", id: "m" },
    options: { maxTokens: 100, reasoningEffort: "high" } as Record<string, unknown>,
    messages: [],
  }
  hook(preset)
  assert.equal(preset.options.maxTokens, 100, "an existing smaller cap is preserved")
  assert.equal(preset.options.reasoningEffort, "high", "a preset reasoning effort is preserved")

  release()
  await settle()
})

test("cuts outgoing messages to the summary once a boundary exists", async () => {
  const h = makeV2Ctx({ options: { ...TRIP_OPTIONS, autoResume: false }, contextMessages: () => SUMMARY_MESSAGES })
  await v2Setup(h.ctx)

  h.feed.push(assistantUpdated())
  await settle() // trip sets boundary=sum_req / summary=sum

  const messages: any[] = [
    ...SUMMARY_MESSAGES,
    { info: { id: "u2", role: "user", sessionID: "s1" }, parts: [{ type: "text", text: "continue" }] },
  ]
  h.takeContextHook()({
    sessionID: "s1",
    model: { providerID: "p", id: "m" },
    options: {},
    messages,
  })

  assert.deepEqual(
    messages.map((m) => m.info.id),
    ["sum_req", "u2"],
  )
  assert.equal(messages[0]!.parts[0]!.text, "## Prior work summary\n\nMY SUMMARY")
})

test("does not cut when V2 summary extraction returned no text", async () => {
  const h = makeV2Ctx({
    options: { ...TRIP_OPTIONS, autoResume: false },
    contextMessages: () => [
      { info: { id: "u1", role: "user", sessionID: "s1" }, parts: [{ type: "text", text: "task" }] },
      { info: { id: "sum", role: "assistant", sessionID: "s1", parentID: "u1" }, parts: [] },
    ],
  })
  await v2Setup(h.ctx)

  h.feed.push(assistantUpdated())
  await settle()

  const messages: any[] = [
    { info: { id: "u1", role: "user", sessionID: "s1" }, parts: [{ type: "text", text: "task" }] },
    { info: { id: "a1", role: "assistant", sessionID: "s1" }, parts: [{ type: "text", text: "ok" }] },
  ]
  h.takeContextHook()({
    sessionID: "s1",
    model: { providerID: "p", id: "m" },
    options: {},
    messages,
  })
  assert.equal(messages.length, 2, "no boundary was recorded, so nothing may be cut")
})

test("extracts the summary from a flat V2 context and cuts it", async () => {
  const flat = () => [
    { id: "u1", type: "user", text: "task" },
    { id: "a1", type: "assistant", content: [{ type: "text", text: "ok" }] },
    { id: "sum_req", type: "user", text: "please summarize" },
    { id: "sum", type: "assistant", content: [{ type: "text", text: "FLAT SUMMARY" }] },
    { id: "idle1", type: "idle", outcome: "succeeded" },
  ]
  const h = makeV2Ctx({
    options: { ...TRIP_OPTIONS }, // autoResume on: extraction must succeed
    promptReturn: { id: "sum_req" },
    contextMessages: flat,
  })
  await v2Setup(h.ctx)

  h.feed.push(assistantUpdated())
  await settle()

  const prompts = promptsOf(h.calls)
  assert.equal(prompts.length, 2, "summary + resume from a flat context")
  assert.match(prompts[0]!.args.text, /handoff summary/i)

  const messages: any[] = flat()
  h.takeContextHook()({
    sessionID: "s1",
    model: { providerID: "p", id: "m" },
    options: {},
    messages,
  })
  assert.deepEqual(
    messages.map((m) => m.id),
    ["sum_req", "idle1"],
  )
  assert.equal(messages[0].text, `## Prior work summary\n\nFLAT SUMMARY`)
})

test("resolves the context limit from model.list when the provider list has none (V2)", async () => {
  const h = makeV2Ctx({
    options: { ...TRIP_OPTIONS, autoResume: false },
    contextMessages: () => SUMMARY_MESSAGES,
  })
  // V2 provider.list entries carry no model limits — only model.list does.
  h.ctx.provider = { list: async () => ({ data: [] }) }
  h.ctx.model = {
    list: async () => ({
      data: [{ providerID: "p", modelID: "m", limit: { context: 10_000 } }],
    }),
  }
  await v2Setup(h.ctx)

  // 8_000 >= 50% of 10_000 (model.list) but far below 50% of the 131072
  // fallback — the trip itself pins the limit source.
  h.feed.push(assistantUpdated())
  await settle()

  assert.equal(promptsOf(h.calls).length, 1, "trip must use the model.list limit")
})

test("Plugin.define accepts the dual entrypoint (V2 package grounding)", async () => {
  // Runtime import lives in tests only (src/** never imports @opencode/plugin).
  const { Plugin } = await import("@opencode/plugin")
  // The real `Context` is nominal to the V2 SDK (e.g. `app`); our setup takes
  // the deliberate structural `V2Ctx` slice. define() is the runtime gate —
  // the grounding is that the import path, namespace, and shape all work.
  const defined = Plugin.define(
    plugin as unknown as Parameters<typeof Plugin.define>[0],
  )
  assert.equal(defined.id, "opencode-cache-compact")
  assert.equal(typeof defined.setup, "function")
})

test("default export is the dual V1+V2 entrypoint", () => {
  const def = plugin as any
  assert.equal(typeof def, "object")
  assert.equal(def.id, "opencode-cache-compact")
  assert.equal(typeof def.setup, "function")
  assert.equal(typeof def.server, "function")
})

test("src/index.ts exports nothing but the default", async () => {
  const ns: any = await import("../src/index.ts")
  assert.deepEqual(Object.keys(ns), ["default"])
})

test("does not summarize below the threshold (V2)", async () => {
  const h = makeV2Ctx({ options: { threshold: 90, abortSettleMs: 0 }, contextMessages: () => SUMMARY_MESSAGES })
  await v2Setup(h.ctx)

  h.feed.push(
    assistantUpdated({
      tokens: { input: 5_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }),
  )
  h.feed.push({ type: "session.idle", data: { sessionID: "s1" } })
  await settle()

  assert.equal(promptsOf(h.calls).length, 0)
})

test("custom summaryPrompt is used verbatim and still read back (V2)", async () => {
  const h = makeV2Ctx({
    options: { ...TRIP_OPTIONS, summaryPrompt: "CUSTOM SUMMARY REQUEST TEXT" },
    contextMessages: () => SUMMARY_MESSAGES,
    promptReturn: { id: "sum_req" },
  })
  await v2Setup(h.ctx)

  h.feed.push(assistantUpdated())
  await settle()

  const prompts = promptsOf(h.calls)
  assert.equal(prompts.length, 2, "summary + resume: extraction succeeded for the custom prompt")
  assert.equal(prompts[0]!.args.text, "CUSTOM SUMMARY REQUEST TEXT", "custom summary prompt must be sent verbatim")
  assert.match(prompts[1]!.args.text, /continue from where you left off/i)
  assert.equal(h.calls.filter((c) => c.name === "wait").length, 1, "the custom summary turn is still waited on")
  assert.equal(h.calls.filter((c) => c.name === "context").length, 1, "and still read back")
})

test("does not treat a stale assistant as the summary when the reply is missing", async () => {
  const staleFixture = () => [
    { info: { id: "u1", role: "user", sessionID: "s1" }, parts: [{ type: "text", text: "task" }] },
    {
      info: { id: "stale", role: "assistant", sessionID: "s1", parentID: "u1" },
      parts: [{ type: "text", text: "old answer" }],
    },
    {
      info: { id: "sum_req", role: "user", sessionID: "s1" },
      parts: [{ type: "text", text: "please summarize" }],
    },
  ]
  const h = makeV2Ctx({
    options: { ...TRIP_OPTIONS }, // autoResume on: a mis-read summary would resume
    promptReturn: { id: "sum_req" },
    contextMessages: staleFixture,
  })
  await v2Setup(h.ctx)

  h.feed.push(assistantUpdated())
  await settle()

  assert.equal(promptsOf(h.calls).length, 1, "no usable summary => no resume")

  // No boundary may have been recorded: the cut must leave history intact.
  const messages: any[] = staleFixture()
  h.takeContextHook()({
    sessionID: "s1",
    model: { providerID: "p", id: "m" },
    options: {},
    messages,
  })
  assert.equal(messages.length, 3, "a stale assistant must never become the cut boundary")
})

test("rejects a reply that is not the child of the admitted request", async () => {
  const h = makeV2Ctx({
    options: { ...TRIP_OPTIONS }, // autoResume on: a wrong boundary would resume
    promptReturn: { id: "sum_req" },
    contextMessages: () => [
      { info: { id: "u1", role: "user", sessionID: "s1" }, parts: [{ type: "text", text: "task" }] },
      {
        info: { id: "sum_req", role: "user", sessionID: "s1" },
        parts: [{ type: "text", text: "please summarize" }],
      },
      {
        info: { id: "sum", role: "assistant", sessionID: "s1", parentID: "u1" },
        parts: [{ type: "text", text: "WRONG PARENT" }],
      },
    ],
  })
  await v2Setup(h.ctx)

  h.feed.push(assistantUpdated())
  await settle()

  assert.equal(promptsOf(h.calls).length, 1, "only the admitted request child may be the summary")
})

test("does not hang the trip when session.wait never resolves", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] })
  const h = makeV2Ctx({
    options: { ...TRIP_OPTIONS, autoResume: false },
    contextMessages: () => SUMMARY_MESSAGES,
    hangWait: true,
  })
  await v2Setup(h.ctx)

  h.feed.push(assistantUpdated())
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve))

  assert.equal(promptsOf(h.calls).length, 1, "the summary turn was sent")
  assert.equal(h.calls.filter((c) => c.name === "wait").length, 1, "waiting for the reply")
  assert.equal(h.calls.filter((c) => c.name === "context").length, 0, "reply not yet available")

  t.mock.timers.tick(SUMMARY_REPLY_TIMEOUT_MS)
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve))

  assert.equal(promptsOf(h.calls).length, 1, "a hang must not resume (no summary)")
  assert.equal(h.calls.filter((c) => c.name === "context").length, 0, "no read-back after a timeout")
  assert.equal(
    h.calls.some(
      (c) =>
        c.name === "app.log" &&
        String((c.args as any)?.body?.message ?? "").includes("timed out waiting for the summary reply"),
    ),
    true,
    "the timeout must be logged",
  )

  // pending was cleared by the failed trip: after the 60s cooldown a fresh
  // over-threshold event trips again (proves no permanent wedge).
  t.mock.timers.tick(60_001)
  h.feed.push(assistantUpdated())
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve))
  assert.equal(promptsOf(h.calls).length, 2, "pending cleared: a later event trips again")

  t.mock.timers.tick(SUMMARY_REPLY_TIMEOUT_MS) // let the second trip finish cleanly
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve))
  t.mock.timers.reset()
})

test("logs when the event subscription fails", async () => {
  const h = makeV2Ctx({ options: { ...TRIP_OPTIONS } })
  h.ctx.event = {
    subscribe: () => ({
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<any>> {
            throw new Error("feed died")
          },
        }
      },
    }),
  } as any
  await v2Setup(h.ctx)
  await settle()

  assert.equal(
    h.calls.some(
      (c) =>
        c.name === "app.log" &&
        String((c.args as any)?.body?.message ?? "").includes("event subscription failed"),
    ),
    true,
    "a dead event feed must be surfaced",
  )
})

