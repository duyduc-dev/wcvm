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
      // lazyDepth 4 matches DEFAULT_PROJECTS_DIR (/home/user/projects/<name> - home/user/projects
      // is 3 segments, so each project's own directory, the 4th, becomes its own lazy-restored
      // unit). Without this, boot restores every persisted project's full node_modules on every
      // single page load - confirmed directly to hit ERR_BOOT_TIMEOUT outright with enough
      // projects accumulated (~10 real React/Vite installs, 774MB/27k files). Lazy restore defers
      // a project's content until something actually opens it instead.
      persist: { lazyDepth: 4 },
    });

    // A real Linux host always has /tmp and os.tmpdir() reports it, but the sandbox's filesystem
    // starts empty - some packages (e.g. @embroider/shared-internals, for Ember) realpathSync it
    // at load and crash on ENOENT.
    await WcvmInstance.ready;
    await WcvmInstance.fs.mkdir("/tmp", { recursive: true });

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
