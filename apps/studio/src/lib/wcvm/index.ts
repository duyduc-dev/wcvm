import { boot, type IWcvm } from "wcvm";

let WcvmInstance: IWcvm;
let bootPromise: Promise<void> | undefined;

// Guarded against double-invocation: React StrictMode (main.tsx) runs mount effects twice in
// dev, and boot() isn't idempotent — an unguarded second call would spin up a second kernel
// (and its Workers) that nothing ever tears down.
const bootWcvm = (): Promise<void> => {
  if (bootPromise) return bootPromise;

  bootPromise = (async () => {
    WcvmInstance = boot({
      persist: true,
    });

    if (import.meta.env.DEV) {
      WcvmInstance.diagnostics.onEvent((e) => {
        console.log(`[bootWcvm][${e.timestamp}] ~ ${e.type} ~ `, e.payload);
      });
    }
  })();

  return bootPromise;
};

const getWcvmInstance = () => {
  if (!WcvmInstance) {
    throw new Error("WcvmInstance is not ready");
  }

  return WcvmInstance;
};

export { bootWcvm, getWcvmInstance };
