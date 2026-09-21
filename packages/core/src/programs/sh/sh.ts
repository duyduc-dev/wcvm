// `sh -c "..."` / `sh script.sh`: sequences pipelines over the existing
// built-in registry - ; && || short-circuiting, | piping stdout to stdin
// in-memory (no real OS pipes needed, everything runs in one worker), and
// > >> < file redirects. `cd` is a shell builtin (it mutates this script's
// own cwd, not a real command). No $ expansion, globbing or background jobs.

import type { IFsClient } from "../../fs/fsClient";
import type { IStdinHost } from "../../runtime/runtime";
import { resolveProgram } from "..";
import type { IProgramContext, Program } from "../types";
import { IPipeline, IScript, ISimpleCommand, parse } from "./parse";
import { ShellSyntaxError } from "./tokenize";

const ERRNO_TEXT: Record<string, string> = {
  ENOENT: "No such file or directory",
  ENOTDIR: "Not a directory",
  EISDIR: "Is a directory",
};
const errnoOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "EIO";
};
const describe = (error: unknown): string => ERRNO_TEXT[errnoOf(error)] ?? errnoOf(error);

const absolute = (cwd: string, path: string): string => (path.startsWith("/") ? path : cwd === "/" ? `/${path}` : `${cwd}/${path}`);

const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const encoder = new TextEncoder();
const toBytes = (data: string | Uint8Array) => (typeof data === "string" ? encoder.encode(data) : data);

/** Delivers a whole file's bytes as one chunk, then EOF; used for `< file`. */
const stdinFromBytes = (data: Uint8Array): IStdinHost => ({
  onData: (handler) => {
    handler(data);
    handler(null);
  },
});

const readFileFor = (fs: IFsClient, cwd: string, target: string, label: string, stderr: (data: string) => void): Uint8Array | undefined => {
  try {
    return fs.readFile(absolute(cwd, target));
  } catch (error) {
    stderr(`sh: ${label}: ${describe(error)}\n`);
    return undefined;
  }
};

/** Writes `bytes` to `target`, appending to whatever's already there for `>>`. */
const writeRedirect = (fs: IFsClient, cwd: string, target: string, append: boolean, bytes: Uint8Array): void => {
  const path = absolute(cwd, target);
  if (!append) {
    fs.writeFile(path, bytes);
    return;
  }
  let existing: ReturnType<IFsClient["readFile"]> = new Uint8Array(0);
  try {
    existing = fs.readFile(path);
  } catch {
    // nothing there yet: append == write
  }
  fs.writeFile(path, concat([existing, bytes]));
};

const runCd = (args: string[], cwd: string, fs: IFsClient, stderr: (data: string) => void): { cwd: string; status: number } => {
  const target = args[0] ?? "/";
  const resolved = absolute(cwd, target);
  try {
    if (fs.stat(resolved).kind !== "dir") throw Object.assign(new Error(), { code: "ENOTDIR" });
  } catch (error) {
    stderr(`cd: ${target}: ${describe(error)}\n`);
    return { cwd, status: 1 };
  }
  return { cwd: resolved, status: 0 };
};

/** A tiny in-memory queue: feeds one pipeline stage's stdout into the next stage's stdin. */
const createPipe = (): { host: IStdinHost; write(chunk: Uint8Array): void; end(): void } => {
  let handler: ((chunk: Uint8Array | null) => void) | null = null;
  const queue: Array<Uint8Array | null> = [];
  const deliver = (item: Uint8Array | null) => {
    if (handler) handler(item);
    else queue.push(item);
  };
  return {
    host: {
      onData: (h) => {
        handler = h;
        for (const item of queue.splice(0)) h(item);
      },
    },
    write: (chunk) => deliver(chunk),
    end: () => deliver(null),
  };
};

const runPipeline = async (pipeline: IPipeline, ctx: IProgramContext, state: { cwd: string }): Promise<number> => {
  const stages = pipeline.commands;
  const pipes = stages.slice(1).map(createPipe);

  const runStage = async (index: number, cmd: ISimpleCommand): Promise<number> => {
    const [name, ...args] = cmd.words;
    if (name === "cd") {
      const result = runCd(args, state.cwd, ctx.fs, ctx.stderr);
      state.cwd = result.cwd;
      return result.status;
    }

    const program = resolveProgram(name);
    if (!program) {
      ctx.stderr(`sh: ${name}: command not found\n`);
      return 127;
    }

    const outRedirect = cmd.redirects.filter((r) => r.type === ">" || r.type === ">>").at(-1) as { type: ">" | ">>"; target: string } | undefined;
    const inRedirect = cmd.redirects.filter((r) => r.type === "<").at(-1);

    let captured: Uint8Array[] | undefined;
    const stdout = (data: string | Uint8Array) => {
      const bytes = toBytes(data);
      if (outRedirect) (captured ??= []).push(bytes);
      else if (index < pipes.length) pipes[index].write(bytes);
      else ctx.stdout(bytes);
    };

    let stdin: IStdinHost | undefined;
    if (inRedirect) {
      const data = readFileFor(ctx.fs, state.cwd, inRedirect.target, inRedirect.target, ctx.stderr);
      if (data === undefined) return 1;
      stdin = stdinFromBytes(data);
    } else {
      stdin = index === 0 ? ctx.stdin : pipes[index - 1].host;
    }

    let status: number;
    try {
      status = await program({
        args,
        cwd: state.cwd,
        env: ctx.env,
        fs: ctx.fs,
        pid: ctx.pid,
        globalObject: ctx.globalObject,
        sleep: ctx.sleep,
        childProcess: ctx.childProcess,
        stdin,
        stdout,
        stderr: ctx.stderr,
      });
    } catch (error) {
      ctx.stderr(`sh: ${name}: ${error instanceof Error ? error.message : String(error)}\n`);
      status = 1;
    }

    if (index < pipes.length) pipes[index].end();
    if (outRedirect) writeRedirect(ctx.fs, state.cwd, outRedirect.target, outRedirect.type === ">>", concat(captured ?? []));
    return status;
  };

  const results = await Promise.all(stages.map((cmd, index) => runStage(index, cmd)));
  return results.at(-1) ?? 0;
};

const runScript = async (script: IScript, ctx: IProgramContext): Promise<number> => {
  const state = { cwd: ctx.cwd };
  let status = 0;
  for (const part of script.parts) {
    if (part.op === "&&" && status !== 0) continue;
    if (part.op === "||" && status === 0) continue;
    status = await runPipeline(part.pipeline, ctx, state);
  }
  return status;
};

const sh: Program = async (ctx) => {
  const { args } = ctx;
  let source: string | undefined;

  if (args[0] === "-c") {
    if (args.length < 2) {
      ctx.stderr("sh: -c requires an argument\n");
      return 2;
    }
    source = args[1];
  } else if (args[0] !== undefined && !args[0].startsWith("-")) {
    const data = readFileFor(ctx.fs, ctx.cwd, args[0], args[0], ctx.stderr);
    if (data === undefined) return 127;
    source = new TextDecoder().decode(data);
  } else {
    ctx.stderr("sh: an interactive REPL is not supported yet; pass -c or a script file\n");
    return 2;
  }

  let script: IScript;
  try {
    script = parse(source);
  } catch (error) {
    ctx.stderr(`sh: ${error instanceof ShellSyntaxError ? error.message : String(error)}\n`);
    return 2;
  }

  return runScript(script, ctx);
};

export { sh };
