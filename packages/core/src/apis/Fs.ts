import { IKernelBridge } from "../bridges/kernel";
import { FileSystemTree, IStatResult } from "../models";

/** Promise-based filesystem API. Rejects with a WcvmError whose `code` is the errno. */
interface IFs {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, contents: string | Uint8Array): Promise<void>;
  exists(path: string): Promise<boolean>;
  readdir(path: string): Promise<string[]>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  stat(path: string): Promise<IStatResult>;
  lstat(path: string): Promise<IStatResult>;
  rm(path: string, options?: { recursive?: boolean }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  symlink(target: string, path: string): Promise<void>;
  readlink(path: string): Promise<string>;
  realpath(path: string): Promise<string>;
  chmod(path: string, mode: number): Promise<void>;
  /** Seeds `tree` under `basePath` (default `/`) in one call. */
  mount(tree: FileSystemTree, basePath?: string): Promise<void>;
  /**
   * Downloads `url` straight into `path` - a real fetch() on a dedicated Fetcher Worker, streamed
   * to disk rather than buffered whole in memory first, with up to 10 other fetch()es in flight
   * at once (a big npm install's own many concurrent package downloads will use this). Rejects
   * (does not write `path`) on a non-2xx response or a network error; like writeFile, does not
   * create `path`'s parent directories.
   */
  fetch(url: string, path: string): Promise<{ status: number; headers: [string, string][] }>;
}

const createFsApi = (
  kernelBridge: IKernelBridge,
  ready: Promise<void>,
): IFs => {
  const call = async <T = void>(
    type: string,
    data: Record<string, unknown> = {},
  ): Promise<T> => {
    await ready;
    return kernelBridge.request<T>(type, data);
  };

  return {
    readFile: (path) => call("fs:readFile", { path }),
    writeFile: (path, contents) => call("fs:writeFile", { path, contents }),
    exists: (path) => call("fs:exists", { path }),
    readdir: (path) => call("fs:readdir", { path }),
    mkdir: (path, options) =>
      call("fs:mkdir", { path, recursive: options?.recursive === true }),
    stat: (path) => call("fs:stat", { path }),
    lstat: (path) => call("fs:lstat", { path }),
    rm: (path, options) =>
      call("fs:rm", { path, recursive: options?.recursive === true }),
    rename: (from, to) => call("fs:rename", { from, to }),
    symlink: (target, path) => call("fs:symlink", { target, path }),
    readlink: (path) => call("fs:readlink", { path }),
    realpath: (path) => call("fs:realpath", { path }),
    chmod: (path, mode) => call("fs:chmod", { path, mode }),
    mount: (tree, basePath = "/") => call("fs:mount", { tree, basePath }),
    fetch: (url, path) => call("fetcher:fetch", { url, path }),
  };
};

export { createFsApi };
export type { IFs };
