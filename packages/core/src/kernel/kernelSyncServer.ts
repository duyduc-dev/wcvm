// Services the second, per-process SAB used by two unrelated blocking capabilities that both
// genuinely need a second real thread to run on while the caller parks on Atomics.wait: execSync/
// spawnSync (OP_SPAWN_SYNC) and the zlib `*Sync` functions (OP_ZLIB_SYNC) - both run straight in
// the Kernel Worker's own realm, no cross-worker hop needed, unlike the fs SAB (whose servicer
// lives in the separate File System Worker). Unlike net.listen() (kernel/netServer.ts), neither
// needs cross-process/global state coordination, so they share this one channel instead of each
// getting their own. `service()` only ever STARTS the async work and returns; the caller stays
// parked on Atomics.wait until it actually finishes (`onExit` for spawn_sync, a resolved/rejected
// promise for zlib_sync) and calls `respondOk`/`respondErr`. (crypto's Hash.digest() used to come
// through here too; it's plain synchronous JS in the process now - bindings/hash.ts.)

import {
  OP_SPAWN_SYNC,
  OP_ZLIB_SYNC,
  SPAWN_SYNC_NO_STATUS,
  decodeBytes,
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
import { runZlibOnce, type ZlibDirection, type ZlibFormat } from "../runtime/bindings/zlib";
import type { IProcessTable } from "./processes";

export interface IKernelSyncServerParams {
  processes: IProcessTable;
  /** Mints a pid for a synchronously-spawned child; must never collide with a live pid. */
  allocatePid: () => number;
}

export interface IKernelSyncServer {
  registerClient(clientId: number, sab: SharedArrayBuffer): void;
  unregisterClient(clientId: number): void;
  /** Call when clientId's doorbell rings: services a parked request, if any. */
  service(clientId: number): void;
}

const createKernelSyncServer = ({ processes, allocatePid }: IKernelSyncServerParams): IKernelSyncServer => {
  const clients = new Map<number, ISyscallViews>();

  const registerClient = (clientId: number, sab: SharedArrayBuffer) => {
    clients.set(clientId, makeViews(sab));
  };
  const unregisterClient = (clientId: number) => {
    clients.delete(clientId);
  };

  const serviceSpawnSync = (views: ISyscallViews, fields: Uint8Array[]) => {
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
  };

  const serviceZlibSync = (views: ISyscallViews, fields: Uint8Array[]) => {
    const [formatBytes, directionBytes, inputBytes] = fields;
    const format = decodeBytes(formatBytes) as ZlibFormat;
    const direction = decodeBytes(directionBytes) as ZlibDirection;
    // Copy out of the SAB's shared data region: some browsers reject Web platform APIs operating
    // on a SharedArrayBuffer-backed view (the same reason protocols/syscall.ts's own decodeBytes
    // copies before TextDecoder.decode()), and the region is about to be overwritten by our own
    // later respondOk() regardless.
    const input = inputBytes.slice();
    runZlibOnce(format, direction, input)
      .then((output) => respondOk(views, output))
      .catch((error) => {
        const code = (error as { code?: unknown })?.code;
        respondErr(views, typeof code === "string" ? code : "EIO");
      });
  };

  const service = (clientId: number) => {
    const views = clients.get(clientId);
    if (!views || !hasPendingRequest(views)) return;

    try {
      const { opcode, fields } = readRequest(views);
      if (opcode === OP_SPAWN_SYNC) serviceSpawnSync(views, fields);
      else if (opcode === OP_ZLIB_SYNC) serviceZlibSync(views, fields);
      else respondErr(views, "ENOSYS");
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      respondErr(views, typeof code === "string" ? code : "EIO");
    }
  };

  return { registerClient, unregisterClient, service };
};

export { createKernelSyncServer };
