// Message shapes exchanged between the kernel worker and the Fetcher Worker - kept in their own
// file, mirroring workers/process/messages.ts, so both sides always agree on the wire shape.

/** Kernel worker -> Fetcher Worker: this worker's own fs client (see kernel/index.ts's
 *  attachFsClient) - reads/writes go straight to the FS Worker over its own SAB, never routed
 *  through the kernel worker's thread. */
export interface IFetcherInit {
  type: "init";
  sab: SharedArrayBuffer;
  port: MessagePort;
}

export interface IFetchRequest {
  type: "fetch";
  id: number;
  url: string;
  path: string;
}

export type FetcherRequest = IFetcherInit | IFetchRequest;

/** Fetcher Worker -> kernel worker. */
export type FetcherEvent =
  | { type: "ready" }
  | { type: "fetch:done"; id: number; status: number; headers: [string, string][] }
  | { type: "fetch:error"; id: number; message: string; code?: string };
