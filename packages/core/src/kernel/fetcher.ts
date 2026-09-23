// The kernel-side half of the Fetcher Worker: turns one wc.fs.fetch(url, path) into one request
// to the dedicated Fetcher Worker (workers/fetcher/worker.ts), which does the real fetch() and
// streams the response straight into the VFS via its own fs client - never through the kernel
// worker's thread, so a big npm install's many concurrent package downloads can't stall the
// kernel's other synchronous responsibilities (spawnSync, net.listen). Mirrors previewRelay.ts's
// own ticket/promise-map shape for a one-shot async operation owned by the kernel.

import type { FetcherEvent } from "../workers/fetcher/messages";

export interface IFetcherWorkerParams {
  postMessage: (message: { type: "fetch"; id: number; url: string; path: string }) => void;
}

export interface IFetchResult {
  status: number;
  headers: [string, string][];
}

export interface IFetcher {
  fetch(url: string, path: string): Promise<IFetchResult>;
  /** Feed this every message the Fetcher Worker posts back, except its initial "ready" - that's
   *  handled by kernel/index.ts's own boot handshake, the same way the fs worker's is. */
  dispatch(event: FetcherEvent): void;
}

interface IPending {
  resolve: (result: IFetchResult) => void;
  reject: (error: Error) => void;
}

const createFetcher = ({ postMessage }: IFetcherWorkerParams): IFetcher => {
  let nextId = 1;
  const pending = new Map<number, IPending>();

  const fetch = (url: string, path: string): Promise<IFetchResult> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      postMessage({ type: "fetch", id, url, path });
    });

  const dispatch = (event: FetcherEvent): void => {
    if (event.type === "ready") return;
    const entry = pending.get(event.id);
    if (!entry) return;
    pending.delete(event.id);
    if (event.type === "fetch:done") {
      entry.resolve({ status: event.status, headers: event.headers });
    } else {
      entry.reject(Object.assign(new Error(event.message), event.code ? { code: event.code } : {}));
    }
  };

  return { fetch, dispatch };
};

export { createFetcher };
