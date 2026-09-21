# Repository Guidelines

## Project Structure & Module Organization

This pnpm workspace contains `wcvm`, a browser-based WebContainer-style runtime
(Node-style projects running fully client-side in Web Workers).

- `packages/core/`: the published `wcvm` library.
  - `src/boot.ts`, `src/apis/`: public API (`boot()`, `spawn()`).
  - `src/bridges/`: main-thread side of the kernel worker (request/response, events).
  - `src/workers/kernel/`: kernel worker (message router + handlers).
  - `src/kernel/`: kernel host (owns the fs client; PID table/supervision still to come).
  - `src/fs/`: `Vfs` (in-memory filesystem), `FsServer` (syscall servicer), `fsClient` (sync client).
  - `src/workers/fs/`: File System Worker; `src/testing/`: test-only helpers.
  - `src/protocols/`: shared protocol code, incl. `syscall.ts` (the SAB syscall ABI),
    diagnostics and state.
- `examples/playground/`: Vite integration demo and Playwright end-to-end coverage.
- `PLAN.md`: phased implementation plan and open decisions. Read it first.
- `PROGRESS.md`: ARCHIVE of the old `duckwc` implementation. Useful history, not
  a description of this tree.

Keep tests beside the module they cover: `packages/core/src/**/Thing.test.ts`.

## Build, Test, and Development Commands

Use pnpm 11 (the version is pinned in `package.json`).

```bash
pnpm install                    # install workspace dependencies
pnpm build                      # build every workspace package
pnpm --filter wcvm test         # run the Vitest unit suite
pnpm --filter playground dev    # start the interactive demo
pnpm --filter playground e2e    # run Playwright browser tests
cd packages/core && npx tsc --noEmit -p .   # typecheck
```

## Coding Style & Naming Conventions

Strict TypeScript, two-space indentation, semicolons, double-quoted strings,
trailing commas where existing code uses them. `camelCase` for values and
functions, `PascalCase` for types/classes, `I`-prefixed interfaces as in existing
code. Keep browser-facing types exported deliberately from `packages/core/src`;
don't leak worker internals. There is no repository-wide formatter: preserve the
conventions of the file you edit.

Node accepts some things browsers reject (e.g. `TextDecoder.decode` on a view over a
SharedArrayBuffer). Changes to worker/SAB code must also pass `pnpm --filter playground e2e`
(real Chromium), not just the Vitest suite.

`protocols/syscall.ts` must stay dependency-free and use erasable TypeScript only
(no enums, no parameter properties): tests import it directly from Node
`worker_threads` with type stripping and no build step.

## Testing Guidelines

Add focused Vitest coverage for every core behavior change, including success,
failure, and message edge cases. Name tests as readable behavior statements within
`describe("module", ...)`. Cross-thread behavior (SAB, `Atomics.wait`) is tested
with real `worker_threads`; see `protocols/syscall.test.ts`. Run the smallest
suite first, then `pnpm --filter wcvm test`.

## Commit & Pull Request Guidelines

Short imperative subjects (`Add`, `Fix`, `Implement`, `Document`). Keep commits
narrowly scoped. PRs should state user-visible impact, tests run, and the
`PLAN.md` phase they advance.
