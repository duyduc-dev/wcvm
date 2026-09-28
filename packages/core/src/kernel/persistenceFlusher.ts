// The kernel-side half of "wait for OPFS persistence to catch up" (wc.fs.sync()): turns one call
// into one {type: "flushPersistence", id} request to the FS Worker and resolves once its matching
// "flushPersistence:done" reply for that same id arrives. Mirrors kernel/fetcher.ts's own
// ticket/promise-map shape for a one-shot async operation owned by the kernel. The FS Worker
// always answers, even when persist isn't enabled at all (see workers/fs/worker.ts) - nothing
// here needs to know or care whether there's actually anything to flush.

import type { FlushPersistenceDone } from "../workers/fs/handler";

export interface IPersistenceFlusherParams {
  postMessage: (message: { type: "flushPersistence"; id: number }) => void;
}

export interface IPersistenceFlusher {
  /** Resolves once every OPFS write queued so far has actually landed - call this before
   *  intentionally reloading/navigating away to be sure nothing recent (a big `npm install`, say)
   *  is lost to the write-behind mirror's own inherent lag. */
  flush(): Promise<void>;
  /** Feed this every "flushPersistence:done" the FS Worker posts back. */
  dispatch(event: FlushPersistenceDone): void;
}

export const createPersistenceFlusher = ({ postMessage }: IPersistenceFlusherParams): IPersistenceFlusher => {
  let nextId = 1;
  const pending = new Map<number, () => void>();

  const flush = (): Promise<void> =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      postMessage({ type: "flushPersistence", id });
    });

  const dispatch = (event: FlushPersistenceDone): void => {
    const resolve = pending.get(event.id);
    if (!resolve) return;
    pending.delete(event.id);
    resolve();
  };

  return { flush, dispatch };
};
