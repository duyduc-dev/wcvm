# Repository Guidelines

## Project Structure & Module Organization

This pnpm workspace contains the browser-based WebContainer-style runtime.

- `packages/core/`: published `duckwc` library. Public APIs live in `src/apis/`; the runtime, virtual filesystem, protocol, bridges, and Workers are under `src/runtime/`, `src/kernel/`, `src/workers/`, and `src/protocol/`.
- `examples/playground/`: Vite integration demo and Playwright end-to-end coverage.
- `apps/docs/`: React/Vite documentation site. `apps/studio/` is a separate Vite UI.
- `PROGRESS.md`: verified behavior, known gaps, and active technical context; update it when changing a tracked capability.

Keep tests beside the module they cover: `packages/core/src/**/Thing.test.ts`.

## Build, Test, and Development Commands

Use pnpm 11 (the version is pinned in `package.json`).

```bash
pnpm install                         # install workspace dependencies
pnpm build                           # build every workspace package/app
pnpm --filter duckwc test         # run the Vitest unit suite
pnpm --filter playground e2e         # run Playwright browser tests
pnpm --filter playground dev         # start the interactive demo
pnpm --filter docs dev               # start the docs site
pnpm --filter docs lint              # lint documentation UI code
pnpm --filter studio lint            # lint Studio
```

The playground’s `predev`/`prebuild` hooks stage its npm and preview-service-worker assets automatically.

## Coding Style & Naming Conventions

Write strict TypeScript with two-space indentation, semicolons, double-quoted strings, and trailing commas where existing code uses them. Use `camelCase` for values and functions, `PascalCase` for types/classes/React components, and descriptive module names such as `syncWireFormat.ts`. Keep browser-facing API types exported deliberately from `packages/core/src`; avoid leaking worker internals.

There is no repository-wide formatter. Preserve the conventions of the file you edit; Docs uses Oxlint and Studio uses ESLint.

## Testing Guidelines

Add or update focused Vitest coverage for every core behavior change, including success, failure, and message/stream edge cases. Name tests as readable behavior statements within `describe("module", ...)`. Run the smallest relevant suite first, then `pnpm --filter duckwc test`. Changes to the demo, preview, or Vite integration should also run `pnpm --filter playground e2e`.

## Commit & Pull Request Guidelines

Recent history uses short imperative subjects, e.g. `Fix exponential blowup in esmLoader.ts's data: URL construction`; use `Document ...` for progress notes and `Add`/`Fix`/`Implement` for code. Keep commits narrowly scoped. PRs should state the user-visible impact, tests run, linked issue or `PROGRESS.md` item where applicable, and screenshots for Docs/Studio UI changes.
