// The kernel-side half of the preview relay: turns one `fetch()` from the host page into one
// virtual TCP connection to whatever real `http.createServer()` is listening on the requested
// port, using the exact same `kernel/netServer.ts` a real process's own `net.connect()` goes
// through - the only difference is `fromPid` is this reserved PREVIEW_PID sentinel instead of a
// real Process Worker, so there's no worker to postMessage to on that side; see kernel/index.ts's
// `notify` wiring, which special-cases it back to this module's own `onNetEvent` instead.
//
// One connection per fetch, closed the moment a full response is parsed (real HTTP is always
// happy to see the client hang up after a response - it's exactly what a non-keep-alive client
// looks like) - simpler than reusing a pool, and avoids leaking a connection (and a ref'd process)
// for every preview request that's never followed by another one to the same port.

import { HttpMessageParser, type IParsedHeadersComplete } from "../runtime/bindings/httpParser";
import type { IPreviewFetchRequest, IPreviewFetchResult } from "../protocols/preview";
import type { NetKernelEvent } from "./netServer";

/** Never a real pid (those start at 1 - see boot.ts's `processId + 1`), so it can be told apart
 *  from every real Process Worker in netServer.ts's own connection bookkeeping. */
export const PREVIEW_PID = 0;

export interface IPreviewRelayParams {
  connect: (ticket: number, port: number) => void;
  writeData: (connId: number, chunk: Uint8Array) => void;
  close: (connId: number) => void;
}

export interface IPreviewRelay {
  fetch(request: IPreviewFetchRequest): Promise<IPreviewFetchResult>;
  /** Feed this every NetKernelEvent kernel/index.ts's `notify` routed to PREVIEW_PID. */
  onNetEvent(event: NetKernelEvent): void;
}

interface IPendingConnect {
  resolve: (connId: number) => void;
  reject: (error: Error) => void;
}

interface IPendingResponse {
  parser: HttpMessageParser;
  chunks: Uint8Array[];
  info?: IParsedHeadersComplete;
  resolve: (result: IPreviewFetchResult) => void;
  reject: (error: Error) => void;
}

const concatBytes = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const flatPairs = (flat: string[]): [string, string][] => {
  const pairs: [string, string][] = [];
  for (let i = 0; i < flat.length; i += 2) pairs.push([flat[i], flat[i + 1]]);
  return pairs;
};

/** Builds a real HTTP/1.1 request's wire bytes. A fetch() body is always fully buffered by the
 *  time it reaches here (the SW awaits request.arrayBuffer() first), so this never needs to
 *  chunk-encode one - a plain Content-Length always says enough. `Connection: close` is set
 *  explicitly (matching the "always exactly one connection per fetch" design above) rather than
 *  left to whatever real net.js's own default happens to be. */
const encodeHttpRequest = (request: IPreviewFetchRequest): Uint8Array => {
  const skip = new Set(["host", "content-length", "connection"]);
  const lines = [`${request.method} ${request.path} HTTP/1.1`, `Host: localhost:${request.port}`, "Connection: close"];
  for (const [name, value] of request.headers) {
    if (!skip.has(name.toLowerCase())) lines.push(`${name}: ${value}`);
  }
  if (request.body) lines.push(`Content-Length: ${request.body.byteLength}`);
  const head = new TextEncoder().encode(`${lines.join("\r\n")}\r\n\r\n`);
  return request.body ? concatBytes([head, request.body]) : head;
};

const createPreviewRelay = ({ connect, writeData, close }: IPreviewRelayParams): IPreviewRelay => {
  let nextTicket = 1;
  const pendingConnects = new Map<number, IPendingConnect>();
  const pendingResponses = new Map<number, IPendingResponse>();

  const fetch = (request: IPreviewFetchRequest): Promise<IPreviewFetchResult> =>
    new Promise((resolve, reject) => {
      const ticket = nextTicket++;
      pendingConnects.set(ticket, {
        // netServer.connect() notifies fromPid (us) with connectResult BEFORE it notifies the
        // listening pid with net:incoming - fine for every OTHER caller, where fromPid is a real
        // process worker and "notify" is an async postMessage, so the listener's own incoming
        // notification is always already in flight (or delivered) by the time that real process
        // could possibly react and write anything. PREVIEW_PID is the one fromPid whose own
        // notify is a direct, SYNCHRONOUS call (see kernel/index.ts) - writing here immediately
        // would race ahead of netServer.connect()'s own still-pending net:incoming notify, in the
        // SAME synchronous call stack, so the real server would see net:data for a connId it
        // hasn't registered yet and silently drop it (a real bug, caught by the very first
        // real-Chromium test that exercised an actual listening server rather than an immediate
        // ECONNREFUSED). Deferring to a microtask guarantees connect()'s own synchronous body -
        // net:incoming included - has already fully run first.
        resolve: (connId) => {
          queueMicrotask(() => {
            const parser = new HttpMessageParser("RESPONSE");
            const entry: IPendingResponse = { parser, chunks: [], resolve, reject };
            parser.onHeadersComplete = (info) => {
              entry.info = info;
            };
            parser.onBody = (chunk) => entry.chunks.push(chunk);
            parser.onMessageComplete = () => {
              pendingResponses.delete(connId);
              close(connId);
              const info = entry.info!;
              resolve({
                status: info.statusCode ?? 502,
                statusMessage: info.statusMessage ?? "",
                headers: flatPairs(info.headers),
                body: concatBytes(entry.chunks),
              });
            };
            pendingResponses.set(connId, entry);
            writeData(connId, encodeHttpRequest(request));
          });
        },
        reject,
      });
      connect(ticket, request.port);
    });

  const onNetEvent = (event: NetKernelEvent): void => {
    switch (event.type) {
      case "net:connectResult": {
        const pending = pendingConnects.get(event.ticket);
        if (!pending) return;
        pendingConnects.delete(event.ticket);
        if (event.ok) pending.resolve(event.connId);
        else pending.reject(Object.assign(new Error(event.code), { code: event.code }));
        return;
      }
      case "net:data": {
        const entry = pendingResponses.get(event.connId);
        if (!entry) return;
        try {
          entry.parser.execute(event.chunk);
        } catch (error) {
          pendingResponses.delete(event.connId);
          entry.reject(error instanceof Error ? error : new Error(String(error)));
        }
        return;
      }
      case "net:eof":
      case "net:close": {
        const entry = pendingResponses.get(event.connId);
        // A well-framed response (Content-Length/chunked) already resolved and removed itself via
        // onMessageComplete before this could ever run (and that path is the only other thing
        // that deletes an entry) - reaching here with none left means this fetch is already done.
        if (!entry) return;
        entry.parser.finish(); // completes a close-delimited body; a no-op for any other phase
        // finish() -> onMessageComplete (if it fired) already deleted this entry and resolved -
        // still here means the connection died before a full response was ever assembled.
        if (pendingResponses.delete(event.connId)) entry.reject(Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" }));
        return;
      }
      // net:incoming never targets PREVIEW_PID - this side only ever connects, never listens.
    }
  };

  return { fetch, onNetEvent };
};

export { createPreviewRelay };
