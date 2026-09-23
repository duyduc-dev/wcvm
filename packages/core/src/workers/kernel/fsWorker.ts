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

// One worker per process, named after its PID so DevTools' worker list maps
// each entry to a process.
const createProcessWorker = (pid: number): IProcessWorkerLike =>
  new Worker(new URL("../process/worker.js", import.meta.url), {
    type: "module",
    name: `Process Worker PID ${pid}`,
  });

// One persistent worker for the kernel's whole lifetime, like the fs worker above - not one per
// request (see kernel/index.ts's own boot handshake for why).
const createFetcherWorker = (): IFetcherWorkerLike =>
  new Worker(new URL("../fetcher/worker.js", import.meta.url), {
    type: "module",
    name: "FetcherWorker",
  });

export { createFetcherWorker, createFsWorker, createProcessWorker };
