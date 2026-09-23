# AGENTS.md

Guidance for agents working in this repo. Read [`README.md`](README.md) first for
what the plugin is and how it is installed.

## Hard rules

**Never run `git commit` or `git push`** unless explicitly asked in that message.
Write files, stage nothing, report what changed, and let the human commit.

**Conventional Commits**, title line only, imperative, lower case, no trailing
period: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, `build:`,
`ci:`, `perf:`. Example: `fix: trip on completed turns instead of idle`.

**Semantic Versioning.** Bump `version` in `package.json` in the same commit:
`feat` → minor, `fix` → patch, breaking → major. `docs`/`test`/`chore` do not
need a bump unless they change published behaviour.

**No secrets, ever** — nothing here needs one.

## What this is

An OpenCode plugin that replaces built-in compaction with a cache-friendly flow:

> threshold crossed → abort the turn → append a summary turn (cache-hit) →
> cut outgoing requests to `[system][tools][summary][…]` → auto-resume.

The on-disk session is never rewritten; only the request sent to the model is.
See README → "How it works".

It is consumed by `lennartschoch/raspi` as a git submodule
(`opencode-cache-compact/`, mounted into the paseo container). Bump that pointer
in the other repo; do not add deployment files here.

## Invariants — do not break these

| Thing | Why |
|---|---|
| `src/index.ts` exports **only** the default plugin | OpenCode registers every function export as its own plugin. Extra value exports duplicate the plugin; a non-plugin export crashes the hook dispatcher. Put shared logic in `src/engine.ts`; version-specific code in the adapters (`src/plugin.ts`, `src/v2.ts`). |
| State lives in module scope (`shared`) | OpenCode may instantiate the plugin more than once; copies must share one registry. `__resetSharedState()` exists for tests. |
| Trigger on completed assistant messages, and abort | `session.idle` only fires at the end of a whole turn; a long agentic turn would overshoot. |
| The cut runs in the request-time message hook (V1 `experimental.chat.messages.transform` / V2 `ctx.session.hook("context")`) | The session must not be mutated; the boundary user turn is rewritten to carry the summary. |
| The default export is the dual object `{ id, setup, server }` — both halves always travel together | V1's object detector arms on `id` alone (`id` without `server` throws); a function default never runs on V2. |
| Empty summary ⇒ no boundary, no resume | Never cut to nothing. |
| `disablePrune` defaults true | Pruning invalidates the cached prefix this plugin exists to keep. |

## Layout

```
index.ts         # V2 directory entry — re-exports ./src/index.ts (V2 probes <dir>/index)
src/index.ts     # entry: `export { default } from "./plugin.ts"` — nothing else
src/plugin.ts    # V1 adapter: options, V1 hooks, host mapping (wraps engine)
src/engine.ts    # shared state machine + Host seam (V1/V2 adapters wrap it)
src/v2.ts        # V2 adapter: setup(ctx) — events, context hook, ctx-based host
src/cut.ts       # pure message-list slicing (tested in isolation)
test/            # cut.test.ts, index.test.ts, v2.test.ts, e2e.test.ts
```

## Commands

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # unit tests (node --test)
npm run test:e2e    # real `opencode serve` + mock model server (opt-in)
```

Node 24+ — the repo runs TypeScript directly and uses `node --test`.

## Verifying

- **Unit** (`npm test`) covers the pure cut and the plugin's state machine with a
  mock client. Any change to the trip/summary/resume flow needs a matching test.
- **End-to-end** (`npm run test:e2e`) is the one that catches real OpenCode
  behaviour: it spawns `opencode serve` with the plugin loaded from source and a
  mock model that records HTTP bodies, then asserts exactly one summary, one
  resume, and that the resume request was cut. Run it after touching the entry
  point, the hooks, or the trigger; it caught the double-instantiation and the
  idle-only-trigger bugs.
- The e2e confines opencode state with `XDG_*` temp dirs; keep it that way.

## Conventions

- `plugin.ts` is single-purpose functions with early returns; `cut.ts` stays pure
  (no SDK, no I/O) so it can be unit-tested directly.
- Prefer explaining *why* in comments — especially around the invariants above.
- Keep the README's caveats table honest: if a workaround is removed, explain the
  cost in the same change.
