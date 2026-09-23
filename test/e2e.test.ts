/**
 * End-to-end tests: one real `opencode serve` process, the real plugin loaded
 * from source, and a mock OpenAI-compatible model server that records the exact
 * HTTP request bodies.
 *
 *   1. a plain turn — trips, summarizes, cuts, resumes;
 *   2. a tool-call loop that never idles — the trip must fire mid-turn, which is
 *      the regression that let a long agentic turn overflow before summarizing.
 *
 * One server is shared across both tests (startup ~0.6s); each test drives its
 * own session and resets the recorder. Opt-in: `npm run test:e2e`.
 *
 * Config and prompt bodies are selected by the host `opencode --version` major
 * (V1: `plugin` tuple + `parts`; V2: `plugins` object + `text`). The version
 * probe runs lazily, only while the e2e is enabled.
 *
 * The mock reports 70k prompt tokens on every response. With a 100k context and
 * threshold 50, that trips on the first step.
 */

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import fs from "node:fs"
import { fileURLToPath } from "node:url"
import { execFileSync, spawn } from "node:child_process"

import { createOpencodeClient } from "@opencode-ai/sdk"
import { createOpencodeClient as createOpencodeV2Client } from "@opencode-ai/sdk/v2"

const enabled = process.env.OPENCODE_E2E === "1"
const here = path.dirname(fileURLToPath(import.meta.url))
const pluginUrl = `file://${path.resolve(here, "../src/index.ts")}`

const pluginDir = path.resolve(here, "..")

// Detect the host `opencode` major version. The probe is deferred on purpose:
// the sandbox has no `opencode` binary, so running it at module import would
// waste a spawn on every `npm test` collection (and crash if unguarded). The
// first call caches the result; any detection failure falls back to 1 (V1).
let detectedMajor: number | undefined
function opencodeMajor(): number {
  if (detectedMajor === undefined) {
    try {
      const out = execFileSync("opencode", ["--version"], { encoding: "utf8" }).trim()
      if (process.env.E2E_DEBUG) console.error(">> e2e opencode --version:", JSON.stringify(out))
      // Version lines vary: "1.18.31", "2.0.14", "opencode v2.0.14" (v2.0.14
      // prints the latter — the old split(".")[0] parse read it as NaN and fell
      // back to 1, which fed the V1 config to a V2 binary).
      const m = out.match(/\bv?(\d+)(\.\d+)+/)
      const parsed = m ? Number.parseInt(m[1]!, 10) : NaN
      detectedMajor = Number.isFinite(parsed) && parsed > 0 ? parsed : 1
    } catch (error) {
      if (process.env.E2E_DEBUG) console.error(">> e2e opencode --version failed:", String(error))
      detectedMajor = 1
    }
  }
  return detectedMajor
}

/**
 * Spawn `opencode serve` and resolve once it is listening.
 *
 * The SDK helper (`createOpencodeServer`) only accepts the V1 banner line
 * (`opencode server listening ...`); opencode v2.0.14 prints
 * `server listening on <url>`, so the helper waited until its timeout with the
 * child alive. Match the URL on any newline-terminated line containing
 * `listening on` (covers both banners), strip ANSI first, and keep the child's
 * output so a startup failure reports WHY instead of a bare timeout.
 */
function startServe(
  config: unknown,
  timeoutMs = 60_000,
): Promise<{ url: string; close: () => void; password: Promise<string | undefined> }> {
  const proc = spawn(
    "opencode",
    [
      "serve",
      "--hostname=127.0.0.1",
      "--port=4096",
      ...(process.env.E2E_DEBUG ? ["--log-level=all"] : []),
    ],
    {
    env: { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config ?? {}) },
  })
  // V2 serve prints `server password <token>` (HTTP Basic, user `opencode`);
  // V1 never does — the promise then settles undefined after 10s and is only
  // awaited on the V2 path.
  let passwordSettled = false
  let resolvePassword!: (value: string | undefined) => void
  const passwordPromise = new Promise<string | undefined>((r) => {
    resolvePassword = r
  })
  let passwordTimer: ReturnType<typeof setTimeout> | undefined
  const settlePassword = (value: string | undefined) => {
    if (passwordSettled) return
    passwordSettled = true
    if (passwordTimer !== undefined) clearTimeout(passwordTimer)
    resolvePassword(value)
  }
  passwordTimer = setTimeout(() => settlePassword(undefined), 10_000)
  return new Promise((resolve, reject) => {
    let output = ""
    let buf = ""
    let ready = false
    const fail = (error: Error) => {
      if (ready) return
      clearTimeout(timer)
      proc.kill()
      reject(error)
    }
    const timer = setTimeout(
      () => fail(new Error(`Timeout waiting for server to start after ${timeoutMs}ms\nServer output: ${output}`)),
      timeoutMs,
    )
    const consider = (line: string) => {
      const clean = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
      if (process.env.E2E_DEBUG && clean.trim()) console.error(">> serve:", clean)
      const pw = clean.match(/^server password (\S+)/)
      if (pw) settlePassword(pw[1]!)
      const m = clean.match(/listening on (https?:\/\/\S+)/)
      if (!m || ready) return
      ready = true
      clearTimeout(timer)
      resolve({
        url: m[1]!,
        close: () => {
          if (proc.exitCode === null && proc.signalCode === null) proc.kill()
        },
        password: passwordPromise,
      })
    }
    const onData = (chunk: Buffer) => {
      const text = chunk.toString()
      output += text
      buf += text
      // Newline-terminated lines only: a partial line could cut the URL short.
      // Keep processing after the banner: V2 prints its auth password on a
      // later line.
      let nl = buf.indexOf("\n")
      while (nl >= 0) {
        consider(buf.slice(0, nl))
        buf = buf.slice(nl + 1)
        nl = buf.indexOf("\n")
      }
    }
    proc.stdout?.on("data", onData)
    proc.stderr?.on("data", onData)
    proc.on("exit", (code) => {
      settlePassword(undefined)
      if (ready) return
      clearTimeout(timer)
      reject(new Error(`Server exited with code ${code}\nServer output: ${output}`))
    })
    proc.on("error", (error) => {
      settlePassword(undefined)
      clearTimeout(timer)
      reject(error)
    })
  })
}

const SUMMARY_TEXT = "MOCK SUMMARY: objective, files changed, next steps."
const TOOL_MARKER = "TOOL_LOOP"

type Recorded = { body: any }

function textOf(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content.map((p: any) => (typeof p === "string" ? p : (p?.text ?? ""))).join("\n")
  }
  return ""
}

function allText(messages: any[]): string {
  return (messages ?? []).map((m) => textOf(m?.content)).join("\n")
}

function startMockModel(readPath: string) {
  const requests: Recorded[] = []
  let toolCalls = 0

  const server = http.createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      if (req.method === "GET" && req.url?.startsWith("/v1/models")) {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ object: "list", data: [{ id: "test-model", object: "model" }] }))
        return
      }
      if (req.method !== "POST" || !req.url?.startsWith("/v1/chat/completions")) {
        res.writeHead(404).end()
        return
      }

      let body: any = {}
      try {
        body = JSON.parse(raw || "{}")
      } catch {
        /* ignore */
      }
      requests.push({ body })

      const usage = { prompt_tokens: 70_000, completion_tokens: 8, total_tokens: 70_008 }
      const model = body.model ?? "test-model"
      const lastUser = [...(body.messages ?? [])].reverse().find((m: any) => m.role === "user")
      const lastUserText = textOf(lastUser?.content)
      const isSummary = /handoff summary/i.test(lastUserText)
      const isResume = /continue from where you left off/i.test(lastUserText)
      // Only the agent request carries tools; title/summary side-requests do not.
      const agentRequest = Array.isArray(body.tools) && body.tools.length > 0
      const wantToolCall =
        agentRequest &&
        !isSummary &&
        !isResume &&
        lastUserText.includes(TOOL_MARKER) &&
        toolCalls < 8

      const sse = (p: unknown) => `data: ${JSON.stringify(p)}\n\n`
      const chunk = (choices: any[], extra: any = {}) => ({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        created: Date.now(),
        model,
        choices,
        ...extra,
      })

      if (body.stream === false) {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(
          JSON.stringify({
            id: "chatcmpl-1",
            object: "chat.completion",
            created: Date.now(),
            model,
            choices: [
              { index: 0, message: { role: "assistant", content: SUMMARY_TEXT }, finish_reason: "stop" },
            ],
            usage,
          }),
        )
        return
      }

      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      })

      if (wantToolCall) {
        toolCalls++
        res.write(
          sse(
            chunk([
              {
                index: 0,
                delta: {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: `call_${toolCalls}`,
                      type: "function",
                      function: { name: "read", arguments: "" },
                    },
                  ],
                },
                finish_reason: null,
              },
            ]),
          ),
        )
        res.write(
          sse(
            chunk([
              {
                index: 0,
                delta: {
                  tool_calls: [
                    { index: 0, function: { arguments: JSON.stringify({ filePath: readPath }) } },
                  ],
                },
                finish_reason: null,
              },
            ]),
          ),
        )
        res.write(sse(chunk([{ index: 0, delta: {}, finish_reason: "tool_calls" }], { usage })))
        res.write("data: [DONE]\n\n")
        res.end()
        return
      }

      res.write(sse(chunk([{ index: 0, delta: { role: "assistant", content: SUMMARY_TEXT }, finish_reason: null }])))
      res.write(sse(chunk([{ index: 0, delta: {}, finish_reason: "stop" }], { usage })))
      res.write("data: [DONE]\n\n")
      res.end()
    })
  })

  return new Promise<{
    baseURL: string
    requests: Recorded[]
    reset: () => void
    close: () => void
  }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number }
      resolve({
        baseURL: `http://127.0.0.1:${port}/v1`,
        requests,
        reset: () => {
          requests.length = 0
          toolCalls = 0
        },
        close: () => server.close(),
      })
    })
  })
}

const summaryFor = (mock: { requests: Recorded[] }) =>
  mock.requests.find((r) => /handoff summary/i.test(allText(r.body.messages)))

const countResumes = (mock: { requests: Recorded[] }) =>
  mock.requests
    .map((r) => (allText(r.body.messages).match(/continue from where you left off/gi) ?? []).length)
    .reduce((a, b) => a + b, 0)

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 30_000): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = fn()
    if (value !== undefined) return value
    if (Date.now() > deadline) return undefined
    await new Promise((r) => setTimeout(r, 25))
  }
}

type Mock = Awaited<ReturnType<typeof startMockModel>>

let mock: Mock
let server: { url: string; close: () => void; password: Promise<string | undefined> }
let client: any // V1 root client or V2 client — surfaces differ (client.v2.session.*)
let home: string

before(async () => {
  if (!enabled) return
  // Keep opencode's startup off the network and the filesystem watcher.
  process.env.OPENCODE_DISABLE_MODELS_FETCH = "1"
  process.env.OPENCODE_DISABLE_AUTOUPDATE = "1"
  process.env.OPENCODE_DISABLE_LSP_DOWNLOAD = "1"
  process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER = "1"
  home = fs.mkdtempSync(path.join(os.tmpdir(), "cache-compact-e2e-"))
  process.env.XDG_DATA_HOME = path.join(home, "data")
  process.env.XDG_CONFIG_HOME = path.join(home, "config")
  process.env.XDG_CACHE_HOME = path.join(home, "cache")
  process.env.XDG_STATE_HOME = path.join(home, "state")

  fs.writeFileSync(path.join(home, "probe.txt"), "hello probe\n")
  // Run opencode inside the temp worktree so the `read` tool's relative path
  // resolves inside the project.
  process.chdir(home)
  mock = await startMockModel("probe.txt")

  const major = opencodeMajor()
  if (process.env.E2E_DEBUG) console.error(">> e2e detected opencode major", major)

  const pluginOptions = {
    threshold: 50,
    models: ["mock/test-model"],
    summaryMaxTokens: 200,
    abortSettleMs: 0,
    // Verbose plugin logging to serve's stderr (echoed under E2E_DEBUG).
    debug: true,
  }

  const config: any =
    major >= 2
      ? {
          $schema: "https://opencode.ai/config.json",
          model: "mock/test-model",
          plugins: [{ package: pluginDir, options: pluginOptions }],
          compaction: { auto: false },
          permissions: [
            { action: "read", resource: "*", effect: "allow" },
            { action: "glob", resource: "*", effect: "allow" },
            { action: "grep", resource: "*", effect: "allow" },
            { action: "list", resource: "*", effect: "allow" },
            { action: "edit", resource: "*", effect: "allow" },
            { action: "shell", resource: "*", effect: "allow" },
            { action: "webfetch", resource: "*", effect: "allow" },
          ],
          providers: {
            mock: {
              package: "aisdk:@ai-sdk/openai-compatible",
              name: "Mock",
              settings: { baseURL: mock.baseURL, apiKey: "test" },
              models: {
                "test-model": {
                  name: "Test Model",
                  capabilities: { tools: true, input: ["text"], output: ["text"] },
                  limit: { context: 100_000, output: 4_096 },
                },
              },
            },
          },
        }
      : {
          $schema: "https://opencode.ai/config.json",
          autoupdate: false,
          model: "mock/test-model",
          small_model: "mock/test-model",
          plugin: [[pluginUrl, pluginOptions]],
          compaction: { auto: false, prune: false },
          permission: { edit: "allow", bash: "allow", webfetch: "allow" },
          provider: {
            mock: {
              npm: "@ai-sdk/openai-compatible",
              name: "Mock",
              options: { baseURL: mock.baseURL, apiKey: "test" },
              models: {
                "test-model": {
                  name: "Test Model",
                  reasoning: false,
                  tool_call: true,
                  limit: { context: 100_000, output: 4_096 },
                },
              },
            },
          },
        }
  server = await startServe(config)
  if (opencodeMajor() >= 2) {
    // v2.0.14 gates /api behind HTTP Basic; user is `opencode`, password is
    // the ephemeral token serve printed at startup (startServe captured it).
    const pw = await server.password
    if (!pw && process.env.E2E_DEBUG)
      console.error(">> no server password line seen; v2 API calls will 401")
    client = createOpencodeV2Client({
      baseUrl: server.url,
      headers: pw ? { Authorization: "Basic " + Buffer.from("opencode:" + pw).toString("base64") } : {},
    })
  } else {
    client = createOpencodeClient({ baseUrl: server.url })
  }
})

after(() => {
  if (!enabled) return
  server?.close()
  mock?.close()
  if (home) {
    if (process.env.E2E_DEBUG) {
      console.error(">> kept temp home for inspection:", home)
    } else {
      fs.rmSync(home, { recursive: true, force: true })
    }
  }
})

async function newSession(title: string, text: string): Promise<string> {
  mock.reset()
  const major = opencodeMajor()
  const onPromptError = (e: unknown) => {
    if (process.env.E2E_DEBUG) console.error(">> prompt failed", String(e))
  }
  if (major >= 2) {
    // V2 serves its session API under /api (behind `client.v2`); the legacy
    // /session routes answer 405 on a V2 binary.
    let created: any
    try {
      // hey-api v0.90 runtime maps FLAT parameter keys (buildClientParams
      // silently drops the typed body/path wrappers); the Data types claim the
      // nested shape — hence the cast.
      created = await client.v2.session.create({
        model: { providerID: "mock", id: "test-model" },
      } as any)
    } catch (e) {
      if (process.env.E2E_DEBUG) console.error(">> v2 session.create threw", String((e as any)?.message ?? e), "status=", (e as any)?.response?.status ?? (e as any)?.status ?? "")
      throw e
    }
    // hey-api wraps the response body in `data`, and the v2 API already
    // envelopes in `{ data }` — unwrap both, tolerate either depth.
    const v2Session = created?.data?.data ?? created?.data ?? created
    if (!v2Session?.id) {
      if (process.env.E2E_DEBUG) {
        // hey-api non-2xx lands in `created.error` with a live Response in
        // `created.response`; both stringify to {} — read them explicitly.
        const resp: any = (created as any)?.response
        let bodyText = ""
        try {
          if (resp && typeof resp.text === "function") bodyText = await resp.text()
        } catch {
          /* body already consumed */
        }
        const err: any = (created as any)?.error
        const errDesc =
          typeof err === "string"
            ? err
            : err == null
              ? String(err)
              : `${err?._tag ?? err?.name ?? typeof err}: ${err?.message ?? ""}`
        console.error(
          ">> v2 session.create no id:",
          "url=", (created as any)?.request?.url,
          "status=", resp?.status,
          "error=", errDesc,
          "body=", bodyText,
        )
      }
      throw new Error("v2 session.create returned no id")
    }
    // Fire-and-forget: in a tool-call loop the turn may not end for a while, and
    // we assert on what the mock received rather than on the prompt returning.
    // v2.0.14 validates the prompt body as PromptInput at the ROOT
    // ({"text": ...}) — the SDK's typed { prompt: PromptInput } wrapper is a
    // newer schema; "$body_text" is hey-api's prefix for a root body key.
    client.v2.session
      .prompt({ sessionID: v2Session.id, $body_text: text } as any)
      .catch(onPromptError)
    return v2Session.id
  }
  const created: any = await client.session.create({ body: { title } })
  const session = created?.data ?? created
  if (!session?.id) {
    if (process.env.E2E_DEBUG) console.error(">> v1 session.create returned no id", JSON.stringify(created))
    throw new Error("session.create returned no id")
  }
  // Fire-and-forget: in a tool-call loop the turn may not end for a while, and
  // we assert on what the mock received rather than on the prompt returning.
  client.session
    .prompt({
      path: { id: session.id },
      body: {
        model: { providerID: "mock", modelID: "test-model" },
        parts: [{ type: "text", text }],
      },
    } as any)
    .catch(onPromptError)
  return session.id
}

test(
  "trips, summarizes, cuts the context, and resumes",
  { skip: enabled ? false : "set OPENCODE_E2E=1 to run (spawns opencode)", timeout: 120_000 },
  async () => {
    await newSession("e2e-plain", "hello from the e2e test")

    const summaryReq = await waitFor(() => summaryFor(mock))
    assert.ok(summaryReq, "plugin never sent the summary turn")
    const summaryIndex = mock.requests.indexOf(summaryReq!)
    const cutReq = await waitFor(() =>
      mock.requests
        .slice(summaryIndex + 1)
        .find((r) => /Prior work summary/i.test(allText(r.body.messages))),
    )
    assert.ok(cutReq, "no cut request after the summary")

    const before = allText(summaryReq!.body.messages)
    const after = allText(cutReq!.body.messages)
    assert.match(before, /hello from the e2e test/)
    assert.match(before, /handoff summary/i)
    assert.doesNotMatch(after, /hello from the e2e test/)
    assert.match(after, /Prior work summary/)
    assert.match(after, /MOCK SUMMARY/)
    assert.match(after, /continue from where you left off/i)

    assert.equal(
      mock.requests.filter((r) => /handoff summary/i.test(allText(r.body.messages))).length,
      1,
      "should summarize exactly once",
    )
    assert.equal(countResumes(mock), 1, "should resume exactly once")
  },
)

test(
  "trips mid-turn across a tool-call loop that never idles",
  { skip: enabled ? false : "set OPENCODE_E2E=1 to run (spawns opencode)", timeout: 120_000 },
  async () => {
    const sessionId = await newSession("e2e-tools", `${TOOL_MARKER}: read the probe file repeatedly`)

    const summaryReq = await waitFor(() => summaryFor(mock), 15_000)
    if (process.env.E2E_DEBUG) {
      console.error(
        `>> summary index=${summaryReq ? mock.requests.indexOf(summaryReq) : "none"} total=${mock.requests.length}`,
      )
      try {
        const msgs: any =
          opencodeMajor() >= 2
            ? await client.v2.session.messages({ sessionID: sessionId } as any)
            : await client.session.messages({ path: { id: sessionId } })
        const list = msgs?.data ?? msgs
        console.error(
          ">> session messages:",
          JSON.stringify(
            (list ?? []).map((m: any) => ({
              role: m.info?.role ?? m.type,
              error: m.info?.error,
              finish: m.info?.finish ?? m.finish,
              tokens: m.info?.tokens ?? m.tokens,
              total: (m.info?.tokens ?? m.tokens)?.total,
              parts: (m.parts ?? m.content ?? []).map((p: any) => p?.type ?? typeof p),
            })),
            null,
            2,
          ),
        )
      } catch (e) {
        console.error(">> messages read failed", String(e))
      }
      console.error(`>> multi-step requests: ${mock.requests.length}`)
      for (const [i, r] of mock.requests.entries()) {
        console.error(
          `  #${i} msgs=${r.body.messages?.length} tools=${r.body.tools?.length} :: ${allText(r.body.messages).slice(0, 100).replace(/\n/g, " ")}`,
        )
      }
      try {
        const logDir = path.join(process.env.XDG_DATA_HOME!, "opencode", "log")
        for (const f of fs.existsSync(logDir) ? fs.readdirSync(logDir) : []) {
          const content = fs.readFileSync(path.join(logDir, f), "utf8")
          console.error(`>> ${f} tail:\n${content.split("\n").slice(-25).join("\n")}`)
        }
      } catch (e) {
        console.error(">> log read failed", String(e))
      }
    }
    assert.ok(summaryReq, "plugin never summarized the tool-call loop")

    // Must trip early, not after exhausting the tool rounds.
    const summaryIndex = mock.requests.indexOf(summaryReq!)
    assert.ok(
      summaryIndex < 4,
      `summary should land mid-turn (early), got request #${summaryIndex}`,
    )

    const cutReq = await waitFor(() =>
      mock.requests
        .slice(summaryIndex + 1)
        .find((r) => /Prior work summary/i.test(allText(r.body.messages))),
    )
    assert.ok(cutReq, "no cut request after the mid-turn summary")
    assert.doesNotMatch(allText(cutReq!.body.messages), /read the probe file repeatedly/)
    assert.equal(countResumes(mock), 1, "should resume exactly once")
  },
)
