# Configuring headers

wcvm only runs on a **cross-origin isolated** page. This is a browser rule, not a wcvm choice: its synchronous filesystem bridge is built on `SharedArrayBuffer` and `Atomics.wait`, and browsers only expose `SharedArrayBuffer` to pages that opt in to isolation.

The opt-in is two response headers on the **document that calls `boot()`**:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Without them `boot()` throws a `WcvmError` with `type: "ERR_NOT_ISOLATED"`. You can check a page in the console:

```js
crossOriginIsolated   // must be true
```

## What the headers do to your page

`require-corp` means **every subresource must opt in** to being loaded by your page. In practice:

- **Your own files** (same origin) just work.
- **Another origin's images, scripts, fonts, iframes and fetches** need either CORS (`Access-Control-Allow-Origin`, with `crossorigin` on the tag) or a `Cross-Origin-Resource-Policy: cross-origin` header on that response. A third-party embed that sends neither is blocked: an analytics script, a video iframe, an image from a CDN.
- **Popups** you open with `window.open` lose their `window.opener` link to your page. OAuth flows that rely on `postMessage` back through `opener` need another approach.

Plan for this before you add third-party content to the page that hosts wcvm. A common layout keeps the sandbox on its own page (or its own subdomain) and the marketing site, with its embeds, elsewhere.

## HTTPS

Cross-origin isolation requires a **secure context**. Production sites must be served over HTTPS. `http://localhost` is exempt, so local development needs no certificate.

## Content-Security-Policy

If you set a CSP, allow `blob:` for workers and scripts. Each process worker, and every ES module a program imports, is loaded from a `blob:` URL:

```
Content-Security-Policy: worker-src 'self' blob:; script-src 'self' blob:
```

Add `wasm-unsafe-eval` to `script-src` if your projects run WebAssembly packages (esbuild-wasm, SWC and similar).

## Your dev server

### Vite

```ts
// vite.config.ts
import { defineConfig } from "vite";

const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  server: { headers: isolation },     // vite dev
  preview: { headers: isolation },    // vite preview
});
```

### Next.js

```js
// next.config.js
module.exports = {
  async headers() {
    return [{
      source: "/(.*)",
      headers: [
        { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
        { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
      ],
    }];
  },
};
```

### SvelteKit

```js
// src/hooks.server.js
export const handle = async ({ event, resolve }) => {
  const response = await resolve(event);
  response.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  response.headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  return response;
};
```

### Express or any Node server

```js
app.use((req, res, next) => {
  res.set("Cross-Origin-Opener-Policy", "same-origin");
  res.set("Cross-Origin-Embedder-Policy", "require-corp");
  next();
});
```

## Static hosting

### Cloudflare Pages

Put a `_headers` file in the folder you deploy (for Vite, in `public/`):

```
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
```

This is what [Studio](https://studio.wcvmjs.com) and these docs use. See `apps/studio/public/_headers` in the repository.

### Netlify

A `_headers` file in the publish folder uses the same syntax as above, or in `netlify.toml`:

```toml
[[headers]]
  for = "/*"
  [headers.values]
    Cross-Origin-Opener-Policy = "same-origin"
    Cross-Origin-Embedder-Policy = "require-corp"
```

### Vercel

```json
{
  "headers": [{
    "source": "/(.*)",
    "headers": [
      { "key": "Cross-Origin-Opener-Policy", "value": "same-origin" },
      { "key": "Cross-Origin-Embedder-Policy", "value": "require-corp" }
    ]
  }]
}
```

### nginx

```nginx
add_header Cross-Origin-Opener-Policy "same-origin" always;
add_header Cross-Origin-Embedder-Policy "require-corp" always;
```

### Only some pages

Isolation is a property of one document. Send the headers only on the route that boots wcvm (for example `/sandbox/*`) and leave the rest of the site alone.

## The preview Service Worker

If you use [`wc.preview`](/guide/preview), one more header may matter. The Service Worker script is registered with scope `/`, and a worker may only control a scope at or below its own script's path. If your bundler serves the script from a nested path (`/assets/PreviewServiceWorker-abc.js`), that file's response must send:

```
Service-Worker-Allowed: /
```

Otherwise `preview.enable()` throws a `SecurityError`. Vite example:

```ts
// vite.config.ts: add to the plugins array
{
  name: "wcvm-preview-sw-headers",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url?.includes("PreviewServiceWorker")) res.setHeader("Service-Worker-Allowed", "/");
      next();
    });
  },
}
```

On Cloudflare Pages, add a rule to `_headers` for the built file instead (Studio's `public/_headers` has the exact pattern).

## Iframes

A page with `require-corp` refuses to embed an iframe whose own response does not also declare a COEP header. The preview Service Worker adds it to everything it serves, so the preview iframe works. An iframe of **your own** that points elsewhere (another site, a page not served through the worker) must send `Cross-Origin-Embedder-Policy` itself, or be loaded with the `credentialless` attribute.

## Checking it from the outside

```bash
curl -sI https://your-site.example/ | grep -i cross-origin
```

You should see both headers on the document. If the page still reports `crossOriginIsolated === false`, look in the console for a message about a blocked subresource, and see [Troubleshooting](/guide/troubleshooting#err-not-isolated).
