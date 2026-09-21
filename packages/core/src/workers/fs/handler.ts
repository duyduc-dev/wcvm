import { FsServer } from "../../fs/FsServer";

type FsWorkerMessage =
  | { type: "register"; clientId: number; sab: SharedArrayBuffer }
  | { type: "unregister"; clientId: number }
  | { type: "doorbell"; clientId: number };

/**
 * The File System Worker's message loop, separated from `self` so it can run
 * (and be tested) anywhere. A doorbell means "this client has a request parked
 * on its SAB".
 */
const createFsWorkerHandler = (server: FsServer) => (message: FsWorkerMessage) => {
  switch (message.type) {
    case "register":
      server.registerClient(message.clientId, message.sab);
      break;
    case "unregister":
      server.unregisterClient(message.clientId);
      break;
    case "doorbell":
      server.service(message.clientId);
      break;
  }
};

export { createFsWorkerHandler };
export type { FsWorkerMessage };
