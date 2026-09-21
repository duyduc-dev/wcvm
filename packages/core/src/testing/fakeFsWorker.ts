import { FsServer } from "../fs/FsServer";
import { IFsWorkerLike } from "../kernel";
import { createFsWorkerHandler } from "../workers/fs/handler";

/**
 * An fs "worker" that runs the real message loop on the same thread and
 * services doorbells synchronously, so a blocking client never actually waits.
 */
export const createFakeFsWorker = (
  server = new FsServer(),
  options: { fail?: string } = {},
) => {
  const handle = createFsWorkerHandler(server);
  const worker: IFsWorkerLike & { terminated: boolean } = {
    terminated: false,
    onmessage: null,
    onerror: null,
    postMessage: (message) => handle(message),
    terminate() {
      worker.terminated = true;
    },
  };
  // Like a real worker, announce readiness (or failure) after the owner has
  // had a chance to attach its listeners.
  queueMicrotask(() => {
    if (options.fail) {
      worker.onerror?.({ message: options.fail } as ErrorEvent);
    } else {
      worker.onmessage?.({ data: { type: "ready" } } as MessageEvent);
    }
  });
  return { worker, server };
};
