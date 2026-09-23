/**
 * V2 directory-plugin entrypoint.
 *
 * OpenCode V2 resolves a configured plugin *directory* by probing
 * `<dir>/server` then `<dir>/index` (Host.resolve in the V2 runtime); it does
 * not read this package's package.json `main`/`exports` for a local
 * directory. V1 loads `src/index.ts` explicitly (file URL or npm main), so
 * both routes land on the same dual `{ id, setup, server }` default export
 * via this re-export. Without this file a local V2 directory entry is
 * silently dropped before load (no log at all).
 */
export { default } from "./src/index.ts"
