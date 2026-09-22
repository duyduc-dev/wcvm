// Assembles a Node-like runtime: the vendored lib/ on our bindings, an event
// loop, a `process`, and a CommonJS loader. The order below mirrors Node's own
// lib/internal/bootstrap/node.js (task queue, then timers, then globals).

import type { IFsClient } from "../fs/fsClient";
import type { ISyscallClient } from "../protocols/syscall";
import { createInternalBinding, type IBindingContext } from "./bindings";
import { createForkIpcPipe, type IChildProcessHost, type IForkIpcHost } from "./bindings/childProcess";
import type { IFsWatchHost } from "./bindings/fs";
import { createModuleSystem } from "./cjs";
import { createEsmLoader } from "./esm/loader";
import { createEsmResolver } from "./esm/resolve";
import { EventLoop, type IEventLoopHost } from "./eventLoop";
import { createBuiltinLoader } from "./loader";
import { createPrimordials } from "./primordials";
import { createProcessObject, NODE_VERSION, ProcessExit } from "./process";
import { startRepl } from "./repl";
import { liftTopLevelDeclarations } from "./replTransform";

export interface IStdinHost {
  /** Registers the one handler for incoming stdin; a null chunk means EOF. */
  onData(handler: (chunk: Uint8Array | null) => void): void;
}

export interface IRuntimeHost {
  write(stream: "stdout" | "stderr", chunk: Uint8Array): void;
  /** Overrides for the scheduler; tests use this to control time. */
  loopHost?: IEventLoopHost;
  /** Backs child_process; without it, `require("child_process")` can't spawn. */
  childProcess?: IChildProcessHost;
  /** Feeds process.stdin; without it, stdin behaves as already at EOF. */
  stdin?: IStdinHost;
  /** Backs child_process.execSync/spawnSync; without it, they throw ENOSYS. */
  spawnSync?: ISyscallClient;
  /** This process's own `fork()` IPC channel; set only when it was itself spawned via `fork()`. */
  ipc?: IForkIpcHost;
  /** Delivers fs.watch change events pushed from the kernel; without it, fs.watch() throws ENOSYS. */
  fsWatch?: IFsWatchHost;
}

export interface IRuntimeOptions {
  fs: IFsClient;
  host: IRuntimeHost;
  argv?: string[];
  env?: Record<string, string>;
  cwd?: string;
  pid?: number;
  /**
   * Install Node's globals (setTimeout, Buffer, console, process, global, ...) onto
   * this object, and use it as `global`. Pass `self` in a dedicated process worker.
   * Left out, modules get them as scope bindings and the real globals stay untouched.
   */
  globalObject?: Record<string, any>;
}

const copyBytes = (chunk: Uint8Array) => Uint8Array.prototype.slice.call(chunk) as Uint8Array;

const createRuntime = (options: IRuntimeOptions) => {
  const { fs, host } = options;
  const cwd = options.cwd ?? "/";

  const process = createProcessObject({
    pid: options.pid ?? 1,
    argv: options.argv ?? ["/bin/node"],
    env: options.env ?? {},
    cwd,
    chdir: (directory) => {
      const target = directory.startsWith("/") ? directory : `${process.cwd()}/${directory}`;
      const real = fs.realpath(target);
      if (fs.stat(real).kind !== "dir") {
        throw Object.assign(new Error(`ENOTDIR: not a directory, chdir '${directory}'`), { code: "ENOTDIR" });
      }
      return real;
    },
  });

  const loop = new EventLoop(host.loopHost);
  const primordials = createPrimordials();
  let loader: ReturnType<typeof createBuiltinLoader>;
  // Named so it can also be handed to createForkIpcPipe below, unchanged: routerFor's cache in
  // bindings/childProcess.ts is keyed by this exact object reference, and setupChannel's
  // channel.onread reads streamBaseState off the SAME router - a different reference would
  // silently build a second, disconnected one.
  const bindingCtx: IBindingContext = {
    requireBuiltin: (id) => loader.requireBuiltin(id),
    loop,
    fs,
    process,
    writeStdio: (fd, chunk) => host.write(fd === 1 ? "stdout" : "stderr", chunk),
    childProcess: host.childProcess,
    spawnSync: host.spawnSync,
    fsWatch: host.fsWatch,
  };
  const internalBinding = createInternalBinding(bindingCtx);
  loader = createBuiltinLoader({ process, internalBinding, primordials });
  const { requireBuiltin } = loader;

  // Node's startup initialises debuglog before anything logs.
  requireBuiltin("internal/util/debuglog").initializeDebugEnv(process.env.NODE_DEBUG);

  // process is an EventEmitter.
  const EventEmitter = requireBuiltin("events");
  Object.setPrototypeOf(process, Object.create(EventEmitter.prototype, {
    constructor: { value: function process() {}, writable: true, configurable: true },
  }));
  EventEmitter.call(process);

  // task queue -> process.nextTick, promise-rejection handling
  const taskQueues = requireBuiltin("internal/process/task_queues");
  const { nextTick, runNextTicks } = taskQueues.setupTaskQueue();
  process.nextTick = nextTick;

  // fork() IPC: process.send()/.on('message')/.channel/.disconnect(), for a process that was
  // itself spawned via fork(). Real Node's bootstrap does this via `_forkChild(fd, mode)`
  // reading NODE_CHANNEL_FD - we have neither a real fd nor that env var, so this reimplements
  // just _forkChild's own few lines (not vendored) instead: build a Pipe wired to the host's
  // ipc capability, and hand it to setupChannel (internal/child_process.js, real vendored logic)
  // directly. Only "json" serialization is supported (the real default; "advanced" needs a real
  // V8 serializer we don't have - see runtime/shims.ts's v8 stub).
  if (host.ipc) {
    const pipe = createForkIpcPipe(bindingCtx, host.ipc);
    const control = requireBuiltin("internal/child_process").setupChannel(process, pipe, "json");
    // setupChannel itself does NOT wire this up - real _forkChild does, right after calling it
    // (internal/child_process.js's `_forkChild`), and we skip _forkChild entirely (no real fd).
    // Without it, `channel.ref()`/`.unref()` (which keep this process alive only while it has a
    // 'message'/'disconnect' listener) never fire at all - confirmed by running an actual forked
    // child with nothing but `process.on('message', ...)`: it exited immediately instead of
    // staying alive, since nothing ever called `control.refCounted()`.
    process.on("newListener", (name: string) => {
      if (name === "message" || name === "disconnect") control.refCounted();
    });
    process.on("removeListener", (name: string) => {
      if (name === "message" || name === "disconnect") control.unrefCounted();
    });
  }

  // timers
  const timers = requireBuiltin("timers");
  const { processImmediate, processTimers } = requireBuiltin("internal/timers").getTimerCallbacks(runNextTicks);
  loop.setupTimers(processImmediate, processTimers);

  // warnings
  const warning = requireBuiltin("internal/process/warning");
  process.emitWarning = warning.emitWarning;
  process.on("warning", warning.onWarning);

  // stdio: real streams over the host's write callback
  const { Writable, Readable } = requireBuiltin("stream");
  const makeOutput = (name: "stdout" | "stderr", fd: number) => {
    const stream = new Writable({
      write(chunk: Uint8Array, _encoding: string, callback: () => void) {
        host.write(name, copyBytes(chunk));
        callback();
      },
    });
    Object.assign(stream, { fd, isTTY: false, _isStdio: true });
    return stream;
  };
  const stdout = makeOutput("stdout", 1);
  const stderr = makeOutput("stderr", 2);
  // Real semantics: open until the host closes it or this process exits, not
  // auto-ended - a script that reads stdin blocks for real data, same as Node.
  // A real handle backing stdin would ref the loop only while actively read
  // from (readStart/readStop); we have no handle, so mirror that off the
  // Readable's own resume/pause/end events instead - a script that never
  // touches stdin must still be able to exit on its own.
  const stdin = new Readable({ read() {} });
  Object.assign(stdin, { fd: 0, isTTY: false });
  if (host.stdin) {
    let release: (() => void) | null = null;
    stdin.on("resume", () => {
      release ??= loop.ref();
    });
    const unref = () => {
      release?.();
      release = null;
    };
    stdin.on("pause", unref);
    stdin.on("end", unref);
    host.stdin.onData((chunk) => stdin.push(chunk));
  } else {
    stdin.push(null);
  }
  Object.defineProperties(process, {
    stdout: { get: () => stdout, enumerable: true, configurable: true },
    stderr: { get: () => stderr, enumerable: true, configurable: true },
    stdin: { get: () => stdin, enumerable: true, configurable: true },
  });

  // console
  const { kBindStreamsLazy } = requireBuiltin("internal/console/constructor");
  const console = requireBuiltin("internal/console/global");
  console[kBindStreamsLazy](process);

  const { Buffer, atob, btoa } = requireBuiltin("buffer");
  const nodePath = requireBuiltin("path");

  // Node's globals, handed to user modules as module-scope bindings so the real
  // globalThis stays untouched (the test runner shares it).
  const globals: Record<string, unknown> = {
    process,
    console,
    Buffer,
    atob,
    btoa,
    setTimeout: timers.setTimeout,
    setInterval: timers.setInterval,
    setImmediate: timers.setImmediate,
    clearTimeout: timers.clearTimeout,
    clearInterval: timers.clearInterval,
    clearImmediate: timers.clearImmediate,
    queueMicrotask: taskQueues.queueMicrotask,
  };
  let globalObject: Record<string, any>;
  if (options.globalObject) {
    globalObject = options.globalObject;
    for (const [name, value] of Object.entries(globals)) {
      Object.defineProperty(globalObject, name, { value, writable: true, configurable: true, enumerable: false });
    }
  } else {
    globalObject = Object.create(globalThis, Object.fromEntries(
      Object.entries(globals).map(([k, value]) => [k, { value, writable: true, configurable: true, enumerable: false }]),
    ));
  }
  Object.defineProperty(globalObject, "global", { value: globalObject, writable: true, configurable: true, enumerable: false });
  globals.global = globalObject;
  // With real globals installed, module scope needs no shadowing at all.
  const moduleGlobals = options.globalObject ? {} : globals;

  const modules = createModuleSystem({
    fs,
    path: nodePath,
    builtins: loader,
    process,
    globals: moduleGlobals,
  });

  // ---- lifecycle ---------------------------------------------------------------

  let exitCode: number | undefined;
  let exited = false;

  const finish = (code: number) => {
    if (exited) return;
    exited = true;
    process.exiting = true;
    process._exiting = true;
    const final = code;
    try {
      process.emit("exit", final);
    } catch (error) {
      if (!(error instanceof ProcessExit)) writeError(error);
    }
    exitCode = process.exitCode !== undefined && code === 0 ? process.exitCode : code;
    loop.abort();
  };

  const writeError = (error: unknown) => {
    const text =
      error instanceof Error
        ? `${error.stack ?? `${error.name}: ${error.message}`}\n`
        : `Uncaught ${requireBuiltin("internal/util/inspect").inspect(error)}\n`;
    host.write("stderr", new TextEncoder().encode(`${text}\nNode.js ${NODE_VERSION}\n`));
  };

  const handleUncaught = (error: unknown) => {
    if (error instanceof ProcessExit) {
      finish(error.exitCode);
      return;
    }
    if (process.listenerCount("uncaughtException") > 0) {
      try {
        process.emit("uncaughtException", error, "uncaughtException");
        return;
      } catch (inner) {
        error = inner;
        if (error instanceof ProcessExit) {
          finish(error.exitCode);
          return;
        }
      }
    }
    writeError(error);
    finish(1);
  };
  loop.onError = handleUncaught;

  process.exit = (code?: number) => {
    if (code !== undefined) process.exitCode = code;
    throw new ProcessExit(process.exitCode ?? 0);
  };
  process.reallyExit = process.exit;

  // A worker reports unhandled rejections as events; Node's JS decides what to do.
  const taskQueue = internalBinding("task_queue");
  const reportUnhandledRejection = (promise: Promise<unknown>, reason: unknown) => {
    taskQueue.reportRejection(0, promise, reason);
    loop.callback(() => {});
  };
  const reportRejectionHandled = (promise: Promise<unknown>) => {
    taskQueue.reportRejection(1, promise);
  };
  const target = globalThis as unknown as { addEventListener?: (t: string, l: (e: any) => void) => void };
  target.addEventListener?.("unhandledrejection", (event) => {
    event.preventDefault?.();
    reportUnhandledRejection(event.promise, event.reason);
  });
  target.addEventListener?.("rejectionhandled", (event) => reportRejectionHandled(event.promise));

  /** Runs `start` (the main script), then the loop until idle; resolves to the exit status. */
  const execute = async (start: () => void): Promise<number> => {
    loop.callback(start);

    while (!exited) {
      await loop.run();
      if (exited) break;
      loop.callback(() => process.emit("beforeExit", process.exitCode ?? 0));
      if (exited) break;
      if (!loop.alive()) break;
    }
    if (!exited) finish(process.exitCode ?? 0);
    return exitCode ?? 0;
  };

  // Format detection alone (extension + nearest package.json "type") needs no
  // parser, so it's cheap enough to build eagerly. The full ESM loader is
  // built lazily off it: most processes (echo, plain CJS scripts) never
  // touch ESM, and acorn is a real (~6k line) parser we shouldn't pay to
  // load for them.
  const esmResolver = createEsmResolver({ fs, path: nodePath, builtins: loader });
  let esmLoader: ReturnType<typeof createEsmLoader> | undefined;
  const getEsmLoader = () => {
    esmLoader ??= createEsmLoader({
      fs,
      path: nodePath,
      acorn: requireBuiltin("internal/deps/acorn/acorn/dist/acorn"),
      builtins: loader,
      requireCjs: (path) => modules.require(path),
      loop,
      globalObject,
    });
    return esmLoader;
  };

  /** Runs the script at `entry` (absolute or cwd-relative). */
  const runMain = (entry: string): Promise<number> => {
    const resolved = entry.startsWith("/") ? entry : nodePath.resolve(process.cwd(), entry);
    process.argv[1] = resolved;
    if (esmResolver.formatOfPath(resolved) === "esm") return execute(() => getEsmLoader().importEntry(resolved));
    return execute(() => modules.runMain(entry));
  };

  /** Runs source text as `node -e` would. */
  const runEval = (source: string): Promise<number> => execute(() => modules.runEval(source));

  /**
   * Starts an interactive session: reads lines from stdin, evaluates each against this
   * process's own real global object (so declarations persist across lines, like Node's own
   * REPL), and prints the result. See runtime/repl.ts.
   */
  const runRepl = (): Promise<number> =>
    execute(() => {
      Object.defineProperty(globalObject, "require", {
        value: (request: string) => modules.require(request, process.cwd()),
        writable: true,
        configurable: true,
        enumerable: false,
      });
      const acorn = requireBuiltin("internal/deps/acorn/acorn/dist/acorn");
      const evaluate = (code: string) => (0, eval)(liftTopLevelDeclarations(acorn, code));
      startRepl({ process, requireBuiltin, evaluate, prompt: "> " });
    });

  return {
    process, loop, loader, globals, globalObject, modules, runMain, runEval, runRepl, stdout, stderr,
    reportUnhandledRejection, reportRejectionHandled,
  };
};

export { createRuntime };
