// `sh -c "..."` / `sh script.sh`: sequences pipelines over the existing
// built-in registry - ; && || short-circuiting, | piping stdout to stdin
// in-memory (no real OS pipes needed, everything runs in one worker), and
// > >> < file redirects. `cd` is a shell builtin (it mutates this script's
// own cwd, not a real command). No $ expansion, globbing or background jobs.
// A name that isn't a builtin is searched through `PATH` like a real shell would
// (`resolveExecutable`, below) - this is what lets `npm run` (programs/npm/runScript.ts) invoke a
// package's own `node_modules/.bin` entries.

import type { IFsClient } from "../../fs/fsClient";
import type { IStdinHost } from "../../runtime/runtime";
import { resolveProgram } from "..";
import type { IProgramContext, Program } from "../types";
import { createLineReader } from "./lineReader";
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

/** A `#!/usr/bin/env node`-style shebang (optionally `env -S ...`, or a direct interpreter path
 *  ending in `node`) - the only interpreter this sandbox can actually hand a script off to. */
const NODE_SHEBANG = /^#!\s*(?:\S*\/env\s+(?:-\S+\s+)*)?(?:\S*\/)?node(?:\s|$)/;

const firstLine = (bytes: Uint8Array): string => {
  const text = new TextDecoder().decode(bytes.length > 256 ? bytes.subarray(0, 256) : bytes);
  const nl = text.indexOf("\n");
  return nl === -1 ? text : text.slice(0, nl);
};

type ResolvedExecutable = { path: string } | { error: "not-found" } | { error: "unsupported" };

/**
 * Resolves `name` to a real executable, the way a real shell would: a name containing `/`
 * resolves directly (relative to `cwd`); a bare name is searched through `PATH` (colon-separated)
 * - `npm run` (`programs/npm/runScript.ts`) prepends every ancestor `node_modules/.bin` to it,
 * the same way real npm does, so a script's own `vite`/`tsc`/... resolves here exactly like it
 * would from a real shell. Only a `#!.../env node` shebang can actually run - there's no other
 * interpreter in this sandbox. The REAL path (following the symlink `npm install` itself creates
 * for a bin) is returned, so a relative `require`/import inside it resolves against the package's
 * own directory, matching real Node's own symlink-following behavior for its main module.
 */
const resolveExecutable = (fs: IFsClient, cwd: string, env: Record<string, string>, name: string): ResolvedExecutable => {
  const candidates = name.includes("/")
    ? [absolute(cwd, name)]
    : (env.PATH ?? "").split(":").filter(Boolean).map((dir) => `${dir.endsWith("/") ? dir.slice(0, -1) : dir}/${name}`);
  for (const candidate of candidates) {
    let kind: string;
    try {
      kind = fs.stat(candidate).kind;
    } catch {
      continue;
    }
    if (kind !== "file") continue;
    if (!NODE_SHEBANG.test(firstLine(fs.readFile(candidate)))) return { error: "unsupported" };
    return { path: fs.realpath(candidate) };
  }
  return { error: "not-found" };
};

type CommandResolution = { program: Program; args: string[] } | { notFound: true } | { unsupported: true };

/** What `runStage` actually needs to invoke `name`: a builtin directly, or - for anything else -
 *  `resolveExecutable`'s real path handed to the `node` builtin. Kept separate from `runStage`
 *  itself so the "not a builtin -> try PATH -> node/not-found/unsupported" branching doesn't add
 *  to ITS own complexity on top of the pipeline/redirect/pipe logic it already has. */
const resolveCommand = (fs: IFsClient, env: Record<string, string>, cwd: string, name: string, args: string[]): CommandResolution => {
  const builtin = resolveProgram(name);
  if (builtin) return { program: builtin, args };
  const resolved = resolveExecutable(fs, cwd, env, name);
  if ("error" in resolved) return resolved.error === "not-found" ? { notFound: true } : { unsupported: true };
  return { program: resolveProgram("node")!, args: [resolved.path, ...args] };
};

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

    const resolution = resolveCommand(ctx.fs, ctx.env, state.cwd, name, args);
    if ("notFound" in resolution) {
      ctx.stderr(`sh: ${name}: command not found\n`);
      return 127;
    }
    if ("unsupported" in resolution) {
      ctx.stderr(`sh: ${name}: cannot execute: unsupported interpreter\n`);
      return 126;
    }
    const { program, args: programArgs } = resolution;

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
      // Spread the whole context, not a hand-picked subset: a nested `node` (from a resolved
      // bin, or a literal `sh -c "node ..."`) needs the same net/fsWatch/spawnSync/workerThread/...
      // capabilities a top-level process gets, or it silently loses them the moment it runs
      // through a shell instead of being spawned directly.
      status = await program({
        ...ctx,
        args: programArgs,
        cwd: state.cwd,
        stdin,
        stdout,
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

const runScript = async (script: IScript, ctx: IProgramContext, state: { cwd: string } = { cwd: ctx.cwd }): Promise<number> => {
  let status = 0;
  for (const part of script.parts) {
    if (part.op === "&&" && status !== 0) continue;
    if (part.op === "||" && status === 0) continue;
    status = await runPipeline(part.pipeline, ctx, state);
  }
  return status;
};

const EXIT_COMMAND = /^exit(?:\s+(\d+))?$/;

/**
 * `sh` with no `-c`/script: reads commands one line at a time from stdin, running each through
 * the same parse+runPipeline machinery as a script file, with `cwd` persisted across lines so
 * `cd` sticks. A syntax error on one line is reported and the session keeps going, unlike a
 * script file (which aborts on its first error).
 */
const runReplSh = async (ctx: IProgramContext): Promise<number> => {
  if (!ctx.stdin) return 0;
  const prompt = ctx.env.PS1 ?? "$ ";
  const reader = createLineReader(ctx.stdin);
  const state = { cwd: ctx.cwd };
  let status = 0;

  for (;;) {
    ctx.stdout(prompt);
    const line = await reader.nextLine();
    if (line === null) {
      ctx.stdout("\n");
      return status;
    }
    const trimmed = line.trim();
    if (trimmed === "") continue;

    const exitMatch = EXIT_COMMAND.exec(trimmed);
    if (exitMatch) return exitMatch[1] ? Number(exitMatch[1]) : status;

    try {
      status = await runScript(parse(line), ctx, state);
    } catch (error) {
      ctx.stderr(`sh: ${error instanceof ShellSyntaxError ? error.message : String(error)}\n`);
    }
    // A command just run in-process (cat, node, a nested sh) may have registered its own
    // stdin handler on this same IStdinHost, displacing this reader's - reclaim it so the
    // next prompt's input reaches the REPL again instead of that now-exited program's handler.
    reader.reattach();
  }
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
  } else if (args[0] === undefined) {
    return runReplSh(ctx);
  } else if (!args[0].startsWith("-")) {
    const data = readFileFor(ctx.fs, ctx.cwd, args[0], args[0], ctx.stderr);
    if (data === undefined) return 127;
    source = new TextDecoder().decode(data);
  } else {
    ctx.stderr(`sh: unknown option: ${args[0]}\n`);
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
