// The `process` object user code sees. Node builds this in C++ plus
// lib/internal/bootstrap; here it is assembled from what the sandbox knows.
// It becomes a real EventEmitter (from the vendored `events`) in bootstrap.ts.

import { ERRNO, SIGNALS } from "./bindings/constants";

export const NODE_VERSION = "v24.18.0";

/** Thrown by process.exit() to unwind the stack; the runtime catches it. */
export class ProcessExit extends Error {
  readonly exitCode: number;
  constructor(exitCode: number) {
    super(`process.exit(${exitCode})`);
    this.name = "ProcessExit";
    this.exitCode = exitCode;
  }
}

export interface IProcessParams {
  pid: number;
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  /** Validates and returns the new cwd, or throws an errno error. */
  chdir(path: string): string;
}

const coerceExitCode = (value: unknown): number | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value);
  if (typeof value === "number" && Number.isInteger(value)) return value;
  const error = new TypeError(
    `The "code" argument must be of type number. Received ${typeof value}`,
  ) as TypeError & { code: string };
  error.code = "ERR_INVALID_ARG_TYPE";
  throw error;
};

export const createProcessObject = (params: IProcessParams) => {
  let cwd = params.cwd;
  let exitCode: number | undefined;
  const startedAt = performance.now();

  const hrtime = Object.assign(
    (previous?: [number, number]): [number, number] => {
      const ms = performance.now();
      let sec = Math.floor(ms / 1000);
      let nsec = Math.floor((ms % 1000) * 1e6);
      if (previous) {
        sec -= previous[0];
        nsec -= previous[1];
        if (nsec < 0) {
          sec--;
          nsec += 1e9;
        }
      }
      return [sec, nsec];
    },
    { bigint: () => BigInt(Math.floor(performance.now() * 1e6)) },
  );

  const process: Record<string, any> = {
    title: "node",
    version: NODE_VERSION,
    versions: { node: NODE_VERSION.slice(1), v8: "13.6.233.17-node.29", uv: "1.51.0", modules: "137" },
    arch: "x64",
    platform: "linux",
    release: { name: "node" },
    pid: params.pid,
    ppid: 0,
    execPath: "/bin/node",
    execArgv: [],
    argv: [...params.argv],
    argv0: "node",
    env: { ...params.env },
    features: {},
    config: { variables: {} },
    exiting: false,
    hrtime,
    uptime: () => (performance.now() - startedAt) / 1000,
    cwd: () => cwd,
    chdir: (directory: string) => {
      cwd = params.chdir(String(directory));
    },
    umask: () => 0o022,
    getuid: () => 1000,
    geteuid: () => 1000,
    getgid: () => 1000,
    getegid: () => 1000,
    memoryUsage: Object.assign(
      () => {
        const heap = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory;
        return {
          rss: heap?.totalJSHeapSize ?? 0,
          heapTotal: heap?.totalJSHeapSize ?? 0,
          heapUsed: heap?.usedJSHeapSize ?? 0,
          external: 0,
          arrayBuffers: 0,
        };
      },
      { rss: () => 0 },
    ),
    cpuUsage: () => ({ user: 0, system: 0 }),
    binding: () => {
      throw new Error("process.binding is not supported");
    },
    constants: { signals: SIGNALS, errno: ERRNO },
  };

  Object.defineProperty(process, "exitCode", {
    enumerable: true,
    configurable: true,
    get: () => exitCode,
    set: (value: unknown) => {
      exitCode = coerceExitCode(value);
    },
  });

  return process;
};
