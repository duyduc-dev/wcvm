import { FsServer } from "../fs/FsServer";
import { IFsWorkerLike } from "../kernel";
import type { IFsWorkerBoot } from "../workers/fs/handler";
import { createFsWorkerHandler } from "../workers/fs/handler";

/**
 * An fs "worker" that runs the real message loop on the same thread and
 * services doorbells synchronously, so a blocking client never actually waits.
 * Ignores any real OPFS persistence a "boot" message asks for (OPFS doesn't exist under
 * Vitest/Node anyway; see fs/opfsPersistence.test.ts for that) but still gates its own "ready"
 * on receiving "boot" first, matching the real worker's contract - and records what `persist`
 * value it was booted with, so a test can assert on it.
 */
export const createFakeFsWorker = (
  server = new FsServer(),
  options: { fail?: string } = {},
) => {
  const handle = createFsWorkerHandler(server);
  const boots: IFsWorkerBoot["persist"][] = [];
  const worker: IFsWorkerLike & { terminated: boolean; boots: IFsWorkerBoot["persist"][] } = {
    terminated: false,
    boots,
    onmessage: null,
    onerror: null,
    postMessage: (message) => {
      if (message.type === "boot") {
        boots.push(message.persist);
        // Like a real worker, announce readiness (or failure) after the owner has had a chance
        // to attach its listeners.
        queueMicrotask(() => {
          if (options.fail) {
            worker.onerror?.({ message: options.fail } as ErrorEvent);
          } else {
            worker.onmessage?.({ data: { type: "ready" } } as MessageEvent);
          }
        });
        return;
      }
      handle(message);
    },
    terminate() {
      worker.terminated = true;
    },
  };
  return { worker, server };
};
