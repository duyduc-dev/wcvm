import { FsServer } from "../fs/FsServer";
import { createFsClient } from "../fs/fsClient";
import {
  createSyscallBuffer,
  createSyscallClient,
  makeViews,
} from "../protocols/syscall";

/**
 * A real fs client wired straight to a real FsServer on ONE thread: the
 * doorbell services the request synchronously, so the response is already in
 * the buffer when the client goes to wait. Test-only; no worker needed.
 */
export const createLoopbackFs = (server = new FsServer()) => {
  const sab = createSyscallBuffer();
  server.registerClient(1, sab);
  const fs = createFsClient(
    createSyscallClient({ ...makeViews(sab), notify: () => server.service(1) }),
  );
  return { fs, server, vfs: server.vfs };
};
