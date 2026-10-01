# Deploying wcvm.js sites

Three static sites, each its own Cloudflare Pages project, all built from this repository:

| Site | Address | Folder | Build command | Output directory |
|---|---|---|---|---|
| Landing page | `wcvmjs.com` | `apps/landing` | `pnpm install --frozen-lockfile && pnpm --filter wcvm-landing... build` | `apps/landing/dist` |
| Studio (the IDE) | `studio.wcvmjs.com` | `apps/studio` | `pnpm install --frozen-lockfile && pnpm --filter "studio..." build` | `apps/studio/dist` |
| Docs | `docs.wcvmjs.com` | `apps/docs` | `pnpm install --frozen-lockfile && pnpm --filter wcvm-docs... build` | `apps/docs/.vitepress/dist` |

The `...` after a package name builds that package **and the workspace packages it depends on** (Studio needs `wcvm` built first). Every project needs the environment variable `NODE_VERSION=24`.

Nothing here needs a server: each site is plain files. Only Studio has special requirements (below).

## One-time setup

### 1. Put the domain on Cloudflare

1. In Cloudflare, **Add a domain**: `wcvmjs.com`, free plan.
2. Cloudflare shows two name servers. At your registrar, replace the domain's current name servers with those two. It can take from a few minutes to 24 hours.
3. When Cloudflare shows the domain as **Active**, continue.

The domain can stay registered at your registrar; only its DNS moves to Cloudflare.

### 2. Create the three Pages projects

For each row in the table: **Workers & Pages -> Create -> Pages -> Connect to Git**, pick `duyduc-dev/wcvm`, and set:

- **Framework preset:** None
- **Build command** and **Build output directory:** from the table
- **Environment variable:** `NODE_VERSION` = `24`

Optional: set **Build watch paths** (Settings -> Build) so a change to one site does not rebuild all three: `apps/landing/*`, `apps/docs/*`, and for Studio `apps/studio/*` plus `packages/core/*`.

### 3. Attach the domains

In each Pages project, open **Custom domains -> Set up a domain** and add:

| Project | Domain |
|---|---|
| landing | `wcvmjs.com` (and `www.wcvmjs.com`) |
| studio | `studio.wcvmjs.com` |
| docs | `docs.wcvmjs.com` |

Cloudflare creates the DNS records and the HTTPS certificates for you. `www` can be a second custom domain of the landing project, or a redirect rule to the apex.

## What Studio needs

Studio only works on a **cross-origin isolated** page, and its preview Service Worker needs a widened scope. `apps/studio/public/_headers` (copied into the build) sets both, so nothing extra is needed on Cloudflare:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Service-Worker-Allowed: /        (for the hashed /assets/PreviewServiceWorker-*.js)
```

The **docs** need it too: their live demo boots wcvm. `apps/docs/public/_headers` sets COOP and COEP on every page, so the docs site must not load
cross-origin subresources that lack CORS/CORP headers (everything is served from its own origin). The landing page needs no isolation.

## Checking a deploy

- **Landing** (`https://wcvmjs.com`): loads, the "Open Studio" and "Read the docs" buttons go to the right sites.
- **Docs** (`https://docs.wcvmjs.com`): loads, search (`/` or Ctrl+K) finds a page, the architecture page shows its diagrams, and on
  `/playground` the **Run** button prints `Node v24...` (`crossOriginIsolated` must be `true`).
- **Studio** (`https://studio.wcvmjs.com`): in the browser console, `crossOriginIsolated` is `true`. Create a blank project, run
  `node -e "require('http').createServer((q,r)=>r.end('ok')).listen(4000)"` in the terminal, and the preview pane shows `ok`.

If the Studio preview pane stays blank, check that the response for `/assets/PreviewServiceWorker-*.js` has `Service-Worker-Allowed: /`.

## Changing the content

- **Landing:** edit `apps/landing/index.html` and `src/style.css`.
- **Docs:** edit the Markdown under `apps/docs/`. `architecture.md` is generated from the repository's `ARCHITECTURE.md`: edit that file and run `node scripts/render-architecture.mjs`.
- **Studio:** see [`apps/studio/README.md`](apps/studio/README.md).

Preview any of them locally with `pnpm --filter <name> dev` (`wcvm-landing` on port 5192, `wcvm-docs` on 5190, `studio` on 5174).
