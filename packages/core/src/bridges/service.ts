interface RegisterKernelWorkerOptions {
  name?: string;
}

const registerKernelWorker = (options: RegisterKernelWorkerOptions = {}): Worker => {
  const worker = new Worker(new URL("workers/kernel/worker.js", import.meta.url), {
    type: "module",
    name: options.name ?? "KernelWorker",
  });

  return worker;
};

export { registerKernelWorker };
