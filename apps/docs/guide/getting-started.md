# Quickstart

This page takes you from an empty project to an Express server running in your browser tab, shown in an `<iframe>`. It is the same sequence every wcvm app follows:

1. [Serve a page that can boot](#_2-serve-a-page-that-can-boot)
2. [Boot](#_3-boot)
3. [Mount your files](#_4-mount-your-files)
4. [Install dependencies](#_5-install-dependencies)
5. [Start the server and show it](#_6-start-the-server-and-show-it)

## 1. Install

```bash
npm install wcvm
```

wcvm is an ES module for the browser and has no runtime dependencies. You need a bundler or dev server that can serve a page with custom headers; the examples use Vite.

## 2. Serve a page that can boot

The page that calls `boot()` must be **cross-origin isolated**: it needs `SharedArrayBuffer`, which browsers only give to pages that send these two headers.

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

With Vite:

```ts
// vite.config.ts
import { defineConfig } from "vite";

const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};
export default defineConfig({ server: { headers: isolation }, preview: { headers: isolation } });
```

`boot()` throws `ERR_NOT_ISOLATED` if they are missing. [Configuring headers](/guide/headers) covers other hosts, third-party content, HTTPS and Content-Security-Policy.

The repository's [playground](https://github.com/duyduc-dev/wcvm/blob/main/examples/playground/vite.config.ts) is a complete working setup, including the Service Worker header the preview needs.

## 3. Boot

```ts
import { boot } from "wcvm";

const wc = boot();      // synchronous: returns straight away
await wc.ready;         // resolves once the kernel worker is up
```

Call `boot()` **once per page** and keep the instance for as long as the page lives. It starts the kernel, the filesystem worker and a worker for downloads; processes are started later, one worker each. `spawn` and every `wc.fs` call wait for `ready` themselves, so awaiting it is optional, but doing so is how you show a "starting" state or catch a failed boot (`ERR_BOOT_TIMEOUT`, `ERR_WORKER`).

To see something run before going further, here is the smallest possible program, live on this page:

<LiveDemo />

```ts
await wc.fs.writeFile("/hello.js", `console.log("hello from", process.version)`);

const proc = await wc.spawn("node", ["hello.js"], { cwd: "/" });
console.log(await new Response(proc.stdout).text());   // hello from v24.18.0
console.log((await proc.exit).exitCode);               // 0
```

## 4. Mount your files

The filesystem is in memory and starts **empty**. `mount` seeds a whole tree in one call, which is much faster than writing files one at a time:

```ts
await wc.fs.mount({
  "package.json": {
    file: {
      contents: JSON.stringify({
        name: "app",
        dependencies: { express: "^4" },
      }),
    },
  },
  "server.js": {
    file: {
      contents: `
        const app = require("express")();
        app.get("/", (req, res) => res.send("hello from the browser"));
        app.listen(3000, () => console.log("listening on 3000"));
      `,
    },
  },
}, "/app");
```

The second argument is where the tree goes (created if missing). A node is a file, a directory or a symlink; see [Working with the file system](/guide/files).

## 5. Install dependencies

```ts
const install = await wc.spawn("npm", ["install"], { cwd: "/app" });
const { exitCode } = await install.exit;
if (exitCode !== 0) throw new Error("npm install failed");
```

This is a real install from `registry.npmjs.org` into `/app/node_modules`. Always check the exit code before starting the server: a failed install otherwise shows up later as "Cannot find module".

To show progress, read the output while it runs (`install.stdout` is a stream of bytes; [Running processes](/guide/processes#reading-output) has a helper for it).

::: tip Speed
A cold install of a larger project takes seconds to tens of seconds, because every package is fetched through the browser. Persist the filesystem (`boot({ persist: true })`) and skip `node_modules` on later visits: see [Persistence](/guide/files#persistence).
:::

## 6. Start the server and show it

wcvm has no `server-ready` event. Instead it tells you when **any** sandbox server starts or stops listening on a virtual port, and a Service Worker relays an `<iframe>` to it:

```ts
const iframe = document.querySelector("iframe")!;

await wc.preview.enable();                                    // registers the Service Worker
wc.preview.onListen(({ port, listening }) => {
  if (listening) iframe.src = wc.preview.url(port);          // "/__wcvm_preview__/3000/"
});

const server = await wc.spawn("node", ["server.js"], { cwd: "/app" });
```

`preview.url(port)` is a same-origin path, so the iframe needs no CORS setup. The preview has its own requirements (a Service Worker header, a base path for client-side routers): see [Preview a dev server](/guide/preview).

## Putting it together

```html
<iframe style="width: 100%; height: 360px; border: 1px solid #ccc"></iframe>
<pre id="log"></pre>
```

```ts
import { boot } from "wcvm";

const log = document.getElementById("log")!;
const pump = async (stream: ReadableStream<Uint8Array>) => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    log.textContent += decoder.decode(value, { stream: true });
  }
};

const wc = boot();
await wc.ready;

await wc.fs.mount({
  "package.json": { file: { contents: JSON.stringify({ dependencies: { express: "^4" } }) } },
  "server.js": {
    file: {
      contents: `require("express")().get("/", (q, r) => r.send("hello from the browser")).listen(3000);`,
    },
  },
}, "/app");

const install = await wc.spawn("npm", ["install"], { cwd: "/app" });
void pump(install.stdout);
if ((await install.exit).exitCode !== 0) throw new Error("npm install failed");

await wc.preview.enable();
wc.preview.onListen(({ port, listening }) => {
  if (listening) document.querySelector("iframe")!.src = wc.preview.url(port);
});

const server = await wc.spawn("node", ["server.js"], { cwd: "/app" });
void pump(server.stdout);
void pump(server.stderr);
```

## Stopping

There is no teardown call for the instance itself: leaving the page ends everything. To stop a running program, call `proc.kill()`; it also kills everything that process started, which frees its ports. Do this when your UI closes a project, otherwise a dev server you stopped looking at keeps running.

## Common first-run problems

| Symptom | Cause |
|---|---|
| `ERR_NOT_ISOLATED` | The page is missing the two headers. [Headers](/guide/headers). |
| The iframe shows your own app or "Not Found" | The Service Worker does not control the page yet. [Troubleshooting](/guide/troubleshooting#the-preview-iframe-shows-your-host-app-or-its-not-found). |
| `npm install` fails with `Failed to fetch` | The registry is not reachable from the browser. |
| `Cannot find module` after a "successful" install | A package needs a `postinstall` step; wcvm's npm does not run lifecycle scripts. [npm](/guide/processes#npm). |

## Where next

- [Working with the file system](/guide/files): seed, read, write, persist.
- [Running processes](/guide/processes): streams, stdin, a terminal, the shell and npm.
- [Preview a dev server](/guide/preview): Vite end to end.
- [Frameworks](/guide/frameworks): what to set for Next.js, Angular, Ember and others.
- Want to see it first? [Open Studio](https://studio.wcvmjs.com), an IDE built on wcvm.
