# Getting started

wcvm runs Node.js projects inside a browser tab. This page takes you from nothing to a running server in an `<iframe>`.

## Install

```bash
npm install wcvm
```

wcvm is an ES module for the browser and has no runtime dependencies.

## 1. Serve a page that can boot

wcvm's synchronous filesystem bridge needs `SharedArrayBuffer`, which browsers only expose on a **cross-origin isolated** page. Serve the page that calls `boot()` with both headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

`boot()` throws `ERR_NOT_ISOLATED` otherwise. With Vite:

```ts
// vite.config.ts
import { defineConfig } from "vite";

const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};
export default defineConfig({ server: { headers: isolation }, preview: { headers: isolation } });
```

::: tip Content-Security-Policy
If you set a CSP, allow `blob:` in `worker-src` and `script-src`: each process worker is loaded from a `blob:` URL.
:::

The repository's [playground](https://github.com/duyduc-dev/wcvm/blob/main/examples/playground/vite.config.ts) is a complete working setup, including the Service Worker header described in [Preview a dev server](/guide/preview).

## 2. Boot and run a command

```ts
import { boot } from "wcvm";

const wc = boot();     // synchronous
await wc.ready;        // the kernel worker is up

await wc.fs.writeFile("/hello.js", `console.log("hello from", process.version)`);

const proc = await wc.spawn("node", ["hello.js"], { cwd: "/" });
console.log(await new Response(proc.stdout).text());   // hello from v24.18.0
console.log((await proc.exit).exitCode);               // 0
```

Try it here, in this page (it is the same `boot()` and `spawn()`):

<LiveDemo />

The filesystem is in memory and starts **empty**. Create the directories you need (including `/tmp` if a tool expects it).

## 3. Install packages and run a server

```ts
await wc.fs.mount({
  "package.json": { file: { contents: JSON.stringify({ dependencies: { express: "^4" } }) } },
  "server.js": {
    file: {
      contents: `
        const app = require("express")();
        app.get("/", (req, res) => res.send("hello from the browser"));
        app.listen(3000, () => console.log("listening"));
      `,
    },
  },
}, "/app");

const install = await wc.spawn("npm", ["install"], { cwd: "/app" });   // real npm registry
await install.exit;

await wc.preview.enable();                                               // registers the preview Service Worker
wc.preview.onListen(({ port, listening }) => {
  if (listening) document.querySelector("iframe")!.src = wc.preview.url(port);
});
await wc.spawn("node", ["server.js"], { cwd: "/app" });
```

## Where next

- [Files and persistence](/guide/files): seed projects, keep them across reloads.
- [Processes, shell and npm](/guide/processes): streams, stdin, the shell and the built-in npm.
- [Preview a dev server](/guide/preview): what the Service Worker needs, and Vite end to end.
- Want to see it first? [Open Studio](https://studio.wcvmjs.com), an IDE built on wcvm.
