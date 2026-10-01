# wcvm docs

The documentation site served at **https://docs.wcvmjs.com**, built with [VitePress](https://vitepress.dev).

```bash
pnpm --filter wcvm-docs dev          # http://localhost:5190
pnpm --filter wcvm-docs build        # -> apps/docs/.vitepress/dist
```

- `guide/` and `reference/` are hand-written Markdown. The guide code samples are the ones the repository's README uses, and were run in
  real Chromium.
- `architecture.md` and `public/architecture/*.svg` are **generated** from the repository's `ARCHITECTURE.md`: edit that file, then run
  `node scripts/render-architecture.mjs` from the repository root.
- Deploy settings are in [`DEPLOYING.md`](../../DEPLOYING.md).
