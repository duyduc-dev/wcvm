import type { Program } from "./types";

const VERSION = "v24.18.0";

const usage = (stderr: (text: string) => void, message: string) => {
  stderr(`node: ${message}\n`);
  return 9;
};

/**
 * `node [script.js [args...]]` and `node -e "code"`: runs the vendored Node
 * runtime inside this process's worker. Loaded on demand so processes that
 * only run `echo` never build a runtime.
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

  if (evalSource === undefined && script === undefined) {
    return usage(stderr, "an interactive REPL is not supported yet; pass a script or -e");
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
    },
  });

  return evalSource !== undefined ? runtime.runEval(evalSource) : runtime.runMain(script!);
};

export { node };
