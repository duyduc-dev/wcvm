import { KernelMessage } from "../../../bridges/models";
import { WcvmError } from "../../../errors/WcvmError";
import { IFsClient } from "../../../fs/fsClient";
import { mountTree } from "../../../kernel/mount";
import { FileSystemTree } from "../../../models";
import { Router } from "../router";

type FsRequest = (fs: IFsClient, data: KernelMessage) => unknown;

const str = (data: KernelMessage, key: string) => data[key] as string;

const fsRequests: Record<string, FsRequest> = {
  "fs:readFile": (fs, d) => fs.readFile(str(d, "path")),
  "fs:writeFile": (fs, d) =>
    fs.writeFile(str(d, "path"), d.contents as string | Uint8Array),
  "fs:exists": (fs, d) => fs.exists(str(d, "path")),
  "fs:readdir": (fs, d) => fs.readdir(str(d, "path")),
  "fs:mkdir": (fs, d) =>
    fs.mkdir(str(d, "path"), { recursive: d.recursive === true }),
  "fs:stat": (fs, d) => fs.stat(str(d, "path")),
  "fs:lstat": (fs, d) => fs.lstat(str(d, "path")),
  "fs:rm": (fs, d) =>
    fs.rm(str(d, "path"), { recursive: d.recursive === true }),
  "fs:rename": (fs, d) => fs.rename(str(d, "from"), str(d, "to")),
  "fs:symlink": (fs, d) => fs.symlink(str(d, "target"), str(d, "path")),
  "fs:readlink": (fs, d) => fs.readlink(str(d, "path")),
  "fs:realpath": (fs, d) => fs.realpath(str(d, "path")),
  "fs:chmod": (fs, d) => fs.chmod(str(d, "path"), d.mode as number),
  "fs:mount": (fs, d) =>
    mountTree(fs, d.tree as FileSystemTree, (d.basePath as string) ?? "/"),
};

/** Routes `fs:*` requests from the host to the kernel's blocking fs client. */
const registerFsHandlers = (router: Router): void => {
  for (const [type, run] of Object.entries(fsRequests)) {
    router.handle(type, ({ event, stateManager }) => {
      const { kernel } = stateManager.getState();
      if (!kernel) throw new WcvmError("ERR_WORKER", "Kernel isn't ready");
      return run(kernel.fs, event.data);
    });
  }
};

export { registerFsHandlers };
