import type { IFsWorkerLike } from "../../kernel";

// Resolved against the bundled kernel worker (dist/workers/kernel/worker.js),
// which sits next to dist/workers/fs/worker.js. Loaded standalone by URL, like
// the kernel worker itself; see tsup.config.ts.
const createFsWorker = (): IFsWorkerLike =>
  new Worker(new URL("../fs/worker.js", import.meta.url), {
    type: "module",
    name: "FsWorker",
  });

export { createFsWorker };
