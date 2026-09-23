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
  | { type: "doorbell"; clientId: number };

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

/**
 * The File System Worker's message loop, separated from `self` so it can run
 * (and be tested) anywhere. A doorbell means "this client has a request parked
 * on its SAB".
 */
const createFsWorkerHandler = (server: FsServer) => {
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
    }
  };
};

export { createFsWorkerHandler };
export type { FsWorkerMessage };
