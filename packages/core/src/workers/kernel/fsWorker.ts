import type { IFetcherWorkerLike, IFsWorkerLike } from "../../kernel";
import type { IProcessWorkerLike } from "../../kernel/processes";

// Resolved against the bundled kernel worker (dist/workers/kernel/worker.js),
// which sits next to dist/workers/fs/worker.js. Loaded standalone by URL, like
// the kernel worker itself; see tsup.config.ts.
const createFsWorker = (): IFsWorkerLike =>
  new Worker(new URL("../fs/worker.js", import.meta.url), {
    type: "module",
    name: "FsWorker",
  });

// The process worker is the only one of these bundles that boots the Node runtime directly onto
// its own real global object (`globalObject: self`, workers/process/worker.ts) - and the only one
// with a computed dynamic import (the ESM/CJS dynamic-import bridge), which is exactly what makes
// a dev server's own JS-module transform (Vite's import-analysis unconditionally prepends an
// `import "/@vite/client"` to any served module with one - confirmed by reading its source, not
// just observing it) inject its HMR client into it. That client's own reconnect `setInterval`
// then lands in the guest's own event loop, since Node's vendored timers module has already
// overwritten `self.setInterval` by the time it fires - a real, reproduced hang under `vite dev`
// (fine under a production build/`vite preview`, which injects nothing).
//
// Fix: never let a dev server get a chance to serve this file's source as a transformable module
// at all. `createProcessWorker()` fetches the built file's raw text ONCE (it's shipped as `.txt`,
// not `.js` - see tsup.config.ts - specifically so a dev server's "this looks like JS" detection
// doesn't even try to transform it) and returns a plain, synchronous per-pid factory that spawns
// each process worker from a same-origin Blob URL built from that already-fetched text. A Blob URL
// is never routed through any dev server at all, so nothing can inject anything into it regardless
// of extension - the .txt shipping is what keeps the ORIGINAL fetch clean in the first place.
const createProcessWorker = async (): Promise<(pid: number) => IProcessWorkerLike> => {
  const source = await fetch(new URL("../process/worker.txt", import.meta.url)).then((res) => res.text());
  return (pid: number) => {
    const blobUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    const worker = new Worker(blobUrl, {
      type: "module",
      name: `Process Worker PID ${pid}`,
    });
    // Safe to revoke immediately: the worker constructor's own fetch of the blob URL is already
    // in flight synchronously by this point (a well-established pattern for "inline worker" code).
    URL.revokeObjectURL(blobUrl);
    return worker;
  };
};

// One persistent worker for the kernel's whole lifetime, like the fs worker above - not one per
// request (see kernel/index.ts's own boot handshake for why).
const createFetcherWorker = (): IFetcherWorkerLike =>
  new Worker(new URL("../fetcher/worker.js", import.meta.url), {
    type: "module",
    name: "FetcherWorker",
  });

export { createFetcherWorker, createFsWorker, createProcessWorker };
