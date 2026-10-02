import { FsServer } from "../../fs/FsServer";
import {
  createOpfsMirror,
  getOpfsRoot,
  restoreFromOpfs,
  restoreFromOpfsLazy,
  type ILazyOpfsRestore,
  type IOpfsMirror,
} from "../../fs/opfsPersistence";
import { Vfs } from "../../fs/Vfs";
import type { FsWatchEvent, IFsWorkerBoot } from "./handler";
import { createFsWorkerHandler, FsWorkerMessage } from "./handler";

const boot = async ({ persist }: IFsWorkerBoot) => {
  const vfs = new Vfs();
  let mirror: IOpfsMirror | undefined;
  let lazyRestore: ILazyOpfsRestore | undefined;

  if (persist) {
    // restoreFromOpfs/restoreFromOpfsLazy already skip individual bad entries on their own (see
    // their own doc comments); this is a final safety net for anything else genuinely unexpected
    // (`getOpfsRoot` itself failing - a real quota/permission error, say - or `root.entries()`
    // throwing outright). This worker must ALWAYS reach "ready" below: failing to do so hangs the
    // WHOLE kernel's boot for 10s with no indication of why (a real, previously-hit bug - see
    // CLAUDE.md's "Status"/"Hard-won gotchas"). Booting without persistence for this session is
    // always better than not booting at all - `mirror` simply stays undefined, same as `persist`
    // never being set.
    try {
      const root = await getOpfsRoot(persist.root);
      // Restored BEFORE the mirror is wired up: onChange is still a no-op at this point, so
      // recreating OPFS's own tree here doesn't turn around and write it straight back to OPFS.
      // (restoreFromOpfsLazy's own later on-demand materialization runs well after this, once the
      // mirror IS wired up - it suppresses onChange itself for exactly that reason, see its own
      // comment.)
      const exclude = new Set(persist.exclude ?? []);
      if (persist.lazyDepth) lazyRestore = await restoreFromOpfsLazy(vfs, root, persist.lazyDepth, exclude);
      else await restoreFromOpfs(vfs, root, "/", exclude);
      mirror = createOpfsMirror(vfs, root, exclude);
    } catch (error) {
      console.error("wcvm: OPFS persistence failed to initialize; booting without it for this session:", error);
    }
  }

  const server = new FsServer(vfs, (clientId, watchId, eventType, filename) => {
    self.postMessage({ type: "watchEvent", clientId, watchId, eventType, filename } satisfies FsWatchEvent);
  }, mirror?.notify);
  const handle = createFsWorkerHandler(server, {
    // No mirror at all (persist wasn't enabled) - resolve immediately, nothing to flush.
    flush: () => mirror?.flush() ?? Promise.resolve(),
    reply: (message) => self.postMessage(message),
    lazyRestore,
  });

  self.onmessage = (e: MessageEvent<FsWorkerMessage>) => handle(e.data);
  // The kernel must not issue a blocking syscall before this worker is running: a parent parked
  // on Atomics.wait can starve a nested worker's startup.
  self.postMessage({ type: "ready" });
};

// A temporary listener, exactly like workers/fetcher/worker.ts's own "init": swapped out for the
// real one (above) once "boot" (with any OPFS persistence to restore first) has been handled.
self.onmessage = (e: MessageEvent<IFsWorkerBoot>) => {
  if (e.data?.type === "boot") void boot(e.data);
};
