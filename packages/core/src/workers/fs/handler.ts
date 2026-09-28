import { FsServer } from "../../fs/FsServer";

type FsWorkerMessage =
  | {
      type: "register";
      clientId: number;
      sab: SharedArrayBuffer;
      /** Doorbell: any message on it means "this client has a request parked". */
      port?: MessagePort;
    }
  | { type: "unregister"; clientId: number }
  | { type: "doorbell"; clientId: number }
  | { type: "flushPersistence"; id: number };

/**
 * Kernel -> FS Worker, sent once, before any `FsWorkerMessage` - handled directly by
 * workers/fs/worker.ts's own temporary boot listener, not createFsWorkerHandler() below (there is
 * no FsServer, and so nothing to register a client with, until this completes). Separate from
 * FsWorkerMessage because it's a one-time boot step, not an ongoing servicing op.
 */
export interface IFsWorkerBoot {
  type: "boot";
  /** OPFS persistence: false (the default) for a purely in-memory Vfs; a root name to restore
   *  from and write-behind mirror to (fs/opfsPersistence.ts) - namespaced so unrelated wcvm
   *  instances on the same origin don't share storage by accident. */
  persist: false | { root: string };
}

/** File System Worker -> kernel: unprompted (not a syscall response), so it's its own
 *  postMessage, not part of the request/response SAB protocol - see FsServer's WatchEventReporter. */
export interface FsWatchEvent {
  type: "watchEvent";
  clientId: number;
  watchId: number;
  eventType: "rename" | "change";
  filename: string;
}

/** File System Worker -> kernel: the reply to one `{type: "flushPersistence", id}` request, once
 *  OPFS persistence (if enabled at all) has actually caught up - see kernel/persistenceFlusher.ts. */
export interface FlushPersistenceDone {
  type: "flushPersistence:done";
  id: number;
}

/**
 * The File System Worker's message loop, separated from `self` so it can run
 * (and be tested) anywhere. A doorbell means "this client has a request parked
 * on its SAB". `persistence`, if given, backs "flushPersistence" - omitted (the default) when
 * `boot({persist})` isn't enabled, in which case it's answered immediately (nothing to flush).
 */
const createFsWorkerHandler = (
  server: FsServer,
  persistence?: { flush: () => Promise<void>; reply: (message: FlushPersistenceDone) => void },
) => {
  const ports = new Map<number, MessagePort>();

  const release = (clientId: number) => {
    const port = ports.get(clientId);
    if (!port) return;
    port.onmessage = null;
    port.close();
    ports.delete(clientId);
  };

  return (message: FsWorkerMessage) => {
    switch (message.type) {
      case "register":
        release(message.clientId);
        server.registerClient(message.clientId, message.sab);
        if (message.port) {
          const { clientId, port } = message;
          port.onmessage = () => server.service(clientId);
          ports.set(clientId, port);
        }
        break;
      case "unregister":
        release(message.clientId);
        server.unregisterClient(message.clientId);
        break;
      case "doorbell":
        server.service(message.clientId);
        break;
      case "flushPersistence": {
        const { id } = message;
        void (persistence?.flush() ?? Promise.resolve()).then(() => persistence?.reply({ type: "flushPersistence:done", id }));
        break;
      }
    }
  };
};

export { createFsWorkerHandler };
export type { FsWorkerMessage };
