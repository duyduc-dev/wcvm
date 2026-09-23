import type { Program } from "./types";

const VERSION = "v24.18.0";

const usage = (stderr: (text: string) => void, message: string) => {
  stderr(`node: ${message}\n`);
  return 9;
};

/**
 * `node [script.js [args...]]`, `node -e "code"`, or `node` with no script (an interactive
 * REPL over stdin): runs the vendored Node runtime inside this process's worker. Loaded on
 * demand so processes that only run `echo` never build a runtime.
 */
const node: Program = async (ctx) => {
  const { args } = ctx;
  const stderr = (text: string) => ctx.stderr(text);

  if (args[0] === "-v" || args[0] === "--version") {
    ctx.stdout(`${VERSION}\n`);
    return 0;
  }

  let evalSource: string | undefined;
  let script: string | undefined;
  let scriptArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-e" || arg === "--eval") {
      if (i + 1 >= args.length) return usage(stderr, `${arg} requires an argument`);
      evalSource = args[++i];
      scriptArgs = args.slice(i + 1);
      break;
    }
    if (arg.startsWith("-") && arg !== "-") return usage(stderr, `bad option: ${arg}`);
    script = arg;
    scriptArgs = args.slice(i + 1);
    break;
  }

  const { createRuntime } = await import("../runtime/runtime");
  const scriptPath =
    script === undefined ? undefined : script.startsWith("/") ? script : `${ctx.cwd === "/" ? "" : ctx.cwd}/${script}`;

  const runtime = createRuntime({
    fs: ctx.fs,
    cwd: ctx.cwd,
    env: ctx.env,
    pid: ctx.pid,
    argv: ["/bin/node", ...(scriptPath ? [scriptPath] : []), ...scriptArgs],
    globalObject: ctx.globalObject,
    host: {
      write: (stream, chunk) => (stream === "stdout" ? ctx.stdout(chunk) : ctx.stderr(chunk)),
      childProcess: ctx.childProcess,
      stdin: ctx.stdin,
      spawnSync: ctx.spawnSync,
      ipc: ctx.ipc,
      fsWatch: ctx.fsWatch,
      net: ctx.net,
      netSync: ctx.netSync,
      udp: ctx.udp,
    },
  });

  if (evalSource !== undefined) return runtime.runEval(evalSource);
  if (script !== undefined) return runtime.runMain(script);
  return runtime.runRepl();
};

export { node };
