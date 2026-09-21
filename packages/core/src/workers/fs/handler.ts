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
