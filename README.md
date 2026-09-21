# wcvm

A WebContainer-style Node.js sandbox that runs entirely in the browser, inside
Web Workers, with no backend. Inspired by
[StackBlitz WebContainers](https://webcontainers.io/).

> **Status: early rewrite.** A virtual filesystem and real processes running
> built-in commands work; there is no Node runtime, shell or networking yet. See
> [`PLAN.md`](PLAN.md) for the roadmap. [`PROGRESS.md`](PROGRESS.md) is the
> archive of the earlier, much larger `duckwc` implementation.

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
const { errorCode } = await proc.exit;                // 0

const sleeper = await wc.spawn("sleep", ["60"]);
sleeper.kill();                                       // exit status 143 (SIGTERM)
```

Built-in commands: `echo`, `cat`, `ls`, `pwd`, `mkdir`, `rm`, `sleep`, `true`,
`false`. An unknown command exits 127. Each process runs in its own Web Worker
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
pnpm --filter playground dev
```

## License

`ISC` per `package.json`; no `LICENSE` file has been added yet.
