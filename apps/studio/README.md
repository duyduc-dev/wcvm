# wcvm Studio

A VS Code-style IDE that runs entirely in the browser, built on [wcvm](../../README.md): Monaco editor,
terminals, a preview pane, and project templates (Vite + React/Vue/Svelte/..., Next.js, SvelteKit, Angular,
Express, NestJS, ...). Projects are stored in the browser (OPFS); there is no backend.

## Run it locally

```bash
pnpm install
pnpm --filter wcvm build            # Studio uses wcvm's built dist/
pnpm --filter studio dev            # http://localhost:5174
```

Use **one Studio tab per browser profile**: tabs of an origin share one preview Service Worker and one OPFS
store, and two tabs running a server on the same port can cross.

## Build

```bash
pnpm --filter "studio..." build     # builds wcvm first, then Studio -> apps/studio/dist
pnpm --filter studio preview        # serves dist/ with the required headers
```

## Deploy (Cloudflare Pages)

Studio is a static site, but it **must be served with cross-origin isolation headers**. `public/_headers`
(copied to the site root by the build) sets them, and `Service-Worker-Allowed` for the preview Service Worker.
Cloudflare Pages and Netlify both read that file; GitHub Pages cannot set these headers, so it will not work.

Create a Cloudflare Pages project connected to this repository (or use `wrangler pages deploy`) with:

| Setting | Value |
|---|---|
| Framework preset | None |
| Build command | `pnpm install --frozen-lockfile && pnpm --filter "studio..." build` |
| Build output directory | `apps/studio/dist` |
| Environment variable | `NODE_VERSION` = `24` |

Cloudflare serves `index.html` for unknown paths when there is no `404.html`, so client-side routes such as
`/editor/<id>` work without a rewrite rule.

After a deploy, check in DevTools that the document response has `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`, and that `crossOriginIsolated` is `true` in the console. Template
installs fetch packages from `registry.npmjs.org`, so the visitor's network must reach it.
