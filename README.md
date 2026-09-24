# wcvm

A WebContainer-style Node.js sandbox that runs entirely in the browser, inside
Web Workers, with no backend. Inspired by
[StackBlitz WebContainers](https://webcontainers.io/).

> **Status: early rewrite.** A virtual filesystem, real processes, and a Node.js
> runtime (`node script.js`, `require`, `fs`, timers, streams, console) work; ESM, a
> shell and networking do not exist yet. See
> [`PLAN.md`](PLAN.md) for the roadmap.

## Usage

```ts
import { boot } from "wcvm";

const wc = boot();          // synchronous; throws if the page isn't cross-origin isolated
await wc.ready;             // resolves when the kernel worker is ready

wc.diagnostics.onEvent((e) => console.log(e.type, e.payload));

await wc.fs.mkdir("/work", { recursive: true });
await wc.fs.writeFile("/work/hello.txt", "hi from the host\n");

const proc = await wc.spawn("cat", ["hello.txt"], { cwd: "/work" });
console.log(await new Response(proc.stdout).text()); // "hi from the host\n"
const { exitCode } = await proc.exit;                // 0

const sleeper = await wc.spawn("sleep", ["60"]);
sleeper.kill();                                       // exit status 143 (SIGTERM)
```

Built-in commands: `echo`, `cat`, `ls`, `pwd`, `mkdir`, `rm`, `sleep`, `true`,
`false` and `node`. An unknown command exits 127.

```ts
await wc.fs.writeFile("/app/main.js", `
  const path = require("path");
  setTimeout(() => console.log("done", path.basename(__filename)), 10);
  console.log("args:", process.argv.slice(2));
`);
const node = await wc.spawn("node", ["main.js", "x"], { cwd: "/app" });
console.log(await new Response(node.stdout).text()); // "args: [ 'x' ]\ndone main.js\n"
```

`node` runs Node's own `lib/` (v24.18.0, vendored verbatim) on a small native layer
written for the browser. It is not full Node: see "Known differences" in
[`PLAN.md`](PLAN.md). Each process runs in its own Web Worker
and talks to the filesystem through a synchronous SharedArrayBuffer bridge.

`boot({ bootTimeoutMs })` rejects `ready` with `ERR_BOOT_TIMEOUT` if the kernel
never answers (default 10s). `spawn()` waits for `ready` before posting.

## Cross-origin isolation (required)

The synchronous bridge needs `SharedArrayBuffer`, which browsers only expose on a
page served with:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

`boot()` throws `ERR_NOT_ISOLATED` otherwise. See
`examples/playground/vite.config.ts` for a Vite setup.

## Development

```bash
pnpm install
pnpm --filter wcvm test
pnpm build
pnpm --filter playground preview
```

Serve the playground from a production build (`preview`), not `pnpm --filter playground dev`:
Vite's dev server injects an HMR client into every `new Worker(url, {type:"module"})`, which is
how every wcvm worker is created, corrupting the guest Node runtime's own timers.

## License

`ISC` per `package.json`; no `LICENSE` file has been added yet.
