// The Fetcher Worker's actual logic: a real fetch() per request, capped at MAX_CONCURRENT
// in-flight at once, each response streamed straight into the VFS via the given fs client's fd
// layer (open/write/close - the same fast path fs.writeFileSync uses under the hood) rather than
// buffered whole in memory first. Kept free of `self` so it runs (and is tested) anywhere; the
// worker entry (worker.ts) only wires it to postMessage and the fs client.

import type { IFsClient } from "../../fs/fsClient";
import { FD_CHUNK } from "../../protocols/syscall";
import type { FetcherEvent, IFetchRequest } from "./messages";

const O_WRONLY = 1;
const O_CREAT = 0o100;
const O_TRUNC = 0o1000;

// PLAN.md: "parallel async fetches capped ~10" - real overlap comes from concurrent in-flight
// fetch() promises on one thread, not OS parallelism, so one worker running up to this many at
// once is enough; no need for a pool of worker threads.
const MAX_CONCURRENT = 10;

export interface IFetcherRuntimeParams {
  fs: IFsClient;
  post: (event: FetcherEvent) => void;
  /** Injectable for tests; defaults to the real global fetch(). */
  fetchImpl?: typeof fetch;
}

export interface IFetcherRuntime {
  /** Queues one fetch request; runs immediately if under the concurrency cap, else waits its turn. */
  enqueue(request: IFetchRequest): void;
}

const createFetcherRuntime = ({ fs, post, fetchImpl = fetch }: IFetcherRuntimeParams): IFetcherRuntime => {
  const queue: IFetchRequest[] = [];
  let active = 0;

  // A single response chunk isn't guaranteed to fit the 1 MiB syscall window (unlikely for a
  // typical fetch() but not spec-guaranteed either) - split it exactly like fsClient.ts's own
  // writeFileChunked does for a big writeFile().
  const writeChunk = (fd: number, chunk: Uint8Array, offset: number): number => {
    let written = offset;
    for (let i = 0; i < chunk.length; i += FD_CHUNK) {
      const piece = chunk.subarray(i, Math.min(i + FD_CHUNK, chunk.length));
      fs.write(fd, piece, written);
      written += piece.length;
    }
    return written;
  };

  const runOne = async ({ id, url, path }: IFetchRequest): Promise<void> => {
    try {
      const response = await fetchImpl(url);
      if (!response.ok) {
        throw Object.assign(new Error(`fetch failed: ${response.status} ${response.statusText} (${url})`), {
          code: `EHTTP${response.status}`,
        });
      }
      const headers: [string, string][] = [...response.headers.entries()];
      const fd = fs.open(path, O_WRONLY | O_CREAT | O_TRUNC, 0o644);
      try {
        if (response.body) {
          const reader = response.body.getReader();
          let offset = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            offset = writeChunk(fd, value, offset);
          }
        }
      } finally {
        fs.close(fd);
      }
      post({ type: "fetch:done", id, status: response.status, headers });
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      post({
        type: "fetch:error",
        id,
        message: error instanceof Error ? error.message : String(error),
        code: typeof code === "string" ? code : undefined,
      });
    }
  };

  const pump = (): void => {
    while (active < MAX_CONCURRENT && queue.length > 0) {
      const request = queue.shift()!;
      active++;
      void runOne(request).finally(() => {
        active--;
        pump();
      });
    }
  };

  const enqueue = (request: IFetchRequest): void => {
    queue.push(request);
    pump();
  };

  return { enqueue };
};

export { createFetcherRuntime, MAX_CONCURRENT };
