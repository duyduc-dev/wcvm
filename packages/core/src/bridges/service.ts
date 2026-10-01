// The options of `new Worker(new URL(...), options)` must be a static literal: bundlers (Vite 5, webpack) read them at
// build time to emit the worker, and refuse a value that is computed at runtime.
const registerKernelWorker = (): Worker =>
  new Worker(new URL("workers/kernel/worker.js", import.meta.url), {
    type: "module",
    name: "KernelWorker",
  });

export { registerKernelWorker };
