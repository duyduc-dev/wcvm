import { FsServer } from "../../fs/FsServer";
import { createOpfsMirror, getOpfsRoot, restoreFromOpfs } from "../../fs/opfsPersistence";
import { Vfs } from "../../fs/Vfs";
import type { FsWatchEvent, IFsWorkerBoot } from "./handler";
import { createFsWorkerHandler, FsWorkerMessage } from "./handler";

const boot = async ({ persist }: IFsWorkerBoot) => {
  const vfs = new Vfs();
  let onPersist: ((path: string) => void) | undefined;

  if (persist) {
    const root = await getOpfsRoot(persist.root);
    // Restored BEFORE the mirror is wired up: onChange is still a no-op at this point, so
    // recreating OPFS's own tree here doesn't turn around and write it straight back to OPFS.
    await restoreFromOpfs(vfs, root);
    onPersist = createOpfsMirror(vfs, root);
  }

  const server = new FsServer(vfs, (clientId, watchId, eventType, filename) => {
    self.postMessage({ type: "watchEvent", clientId, watchId, eventType, filename } satisfies FsWatchEvent);
  }, onPersist);
  const handle = createFsWorkerHandler(server);

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
