# wcvm

A WebContainer-style Node.js sandbox that runs entirely in the browser, inside
Web Workers, with no backend. Inspired by
[StackBlitz WebContainers](https://webcontainers.io/).

> **Status: early rewrite.** Only the kernel worker, boot handshake and the
> synchronous syscall protocol exist so far. `spawn()` is still a stub. See
> [`PLAN.md`](PLAN.md) for the roadmap. [`PROGRESS.md`](PROGRESS.md) is the
> archive of the earlier, much larger `duckwc` implementation.

## Usage

```ts
import { boot } from "wcvm";

const wc = boot();          // synchronous; throws if the page isn't cross-origin isolated
await wc.ready;             // resolves when the kernel worker is ready

wc.diagnostics.onEvent((e) => console.log(e.type, e.payload));

const proc = await wc.spawn("echo", ["Hello, World!"]);
const { errorCode } = await proc.exit;
```

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
