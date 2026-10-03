import { boot, type IWcvm } from "wcvm";

let WcvmInstance: IWcvm;
let bootPromise: Promise<void> | undefined;

// The embedded editor (/embed) is a throwaway sandbox for the host page: nothing is persisted to
// OPFS, so one site's files never show up in another's (or in Studio's own project list).
const isEmbedded = () => location.pathname.startsWith("/embed");

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
      //
      // exclude node_modules: it's thousands of small files that `npm install` recreates, and
      // mirroring them to OPFS is what made creating a project slow. It lives in memory for the
      // session; the editor reinstalls it when a project is opened without it
      // (IdeController.installDependenciesIfNeeded).
      persist: isEmbedded() ? undefined : { lazyDepth: 4, exclude: ["node_modules"] },
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
