// Services the second, per-process SAB used by execSync/spawnSync (OP_SPAWN_SYNC), straight in
// the Kernel Worker's own realm - no cross-worker hop needed, unlike the fs SAB (whose servicer
// lives in the separate File System Worker). `service()` only ever STARTS the child and returns;
// the caller stays parked on Atomics.wait until `onExit` (kernel/processes.ts) eventually calls
// `respondOk`, once the child has actually finished.

import {
  OP_SPAWN_SYNC,
  SPAWN_SYNC_NO_STATUS,
  decodeBytes,
  decodeRequest,
  encodeRequest,
  encodeString,
  hasPendingRequest,
  makeViews,
  readRequest,
  respondErr,
  respondOk,
  u32ToBytes,
  bytesToU32,
  type ISyscallViews,
} from "../protocols/syscall";
import type { IProcessTable } from "./processes";

export interface ISpawnSyncServerParams {
  processes: IProcessTable;
  /** Mints a pid for a synchronously-spawned child; must never collide with a live pid. */
  allocatePid: () => number;
}

export interface ISpawnSyncServer {
  registerClient(clientId: number, sab: SharedArrayBuffer): void;
  unregisterClient(clientId: number): void;
  /** Call when clientId's doorbell rings: services a parked request, if any. */
  service(clientId: number): void;
}

const createSpawnSyncServer = ({ processes, allocatePid }: ISpawnSyncServerParams): ISpawnSyncServer => {
  const clients = new Map<number, ISyscallViews>();

  const registerClient = (clientId: number, sab: SharedArrayBuffer) => {
    clients.set(clientId, makeViews(sab));
  };
  const unregisterClient = (clientId: number) => {
    clients.delete(clientId);
  };

  const service = (clientId: number) => {
    const views = clients.get(clientId);
    if (!views || !hasPendingRequest(views)) return;

    try {
      const { opcode, fields } = readRequest(views);
      if (opcode !== OP_SPAWN_SYNC) {
        respondErr(views, "ENOSYS");
        return;
      }

      const [commandBytes, argsBytes, cwdBytes, envBytes, input, timeoutBytes] = fields;
      const command = decodeBytes(commandBytes);
      const args: string[] = JSON.parse(decodeBytes(argsBytes) || "[]");
      const cwd = decodeBytes(cwdBytes) || undefined;
      const envJson = decodeBytes(envBytes);
      const env: Record<string, string> | undefined = envJson ? JSON.parse(envJson) : undefined;
      const timeoutMs = bytesToU32(timeoutBytes);

      const pid = allocatePid();
      processes.spawn({
        processId: pid,
        command,
        args,
        cwd,
        env,
        timeoutMs: timeoutMs || undefined,
        onExit: (result) => {
          const status = result.signal ? SPAWN_SYNC_NO_STATUS : result.code;
          const payload = encodeRequest([u32ToBytes(pid), u32ToBytes(status), encodeString(result.signal ?? ""), result.stdout, result.stderr]);
          respondOk(views, payload);
        },
      });

      // Copy input out of the SAB's shared data region first: it's about to be overwritten (by
      // a later respondOk, once the child exits) and postMessage would otherwise hand the
      // worker a live view over the same shared memory instead of a snapshot.
      if (input.length > 0) processes.writeStdin(pid, input.slice());
      processes.endStdin(pid);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      respondErr(views, typeof code === "string" ? code : "EIO");
    }
  };

  return { registerClient, unregisterClient, service };
};

export { createSpawnSyncServer };
