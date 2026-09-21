import type { IFsClient } from "../fs/fsClient";
import { node } from "./node";
import type { IProgramContext, Program } from "./types";

const ERRNO_TEXT: Record<string, string> = {
  ENOENT: "No such file or directory",
  EEXIST: "File exists",
  ENOTDIR: "Not a directory",
  EISDIR: "Is a directory",
  ENOTEMPTY: "Directory not empty",
  EBUSY: "Device or resource busy",
  EINVAL: "Invalid argument",
  ELOOP: "Too many levels of symbolic links",
};

const errnoOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "EIO";
};
const describe = (error: unknown): string =>
  ERRNO_TEXT[errnoOf(error)] ?? errnoOf(error);

const absolute = (cwd: string, path: string): string => {
  if (path.startsWith("/")) return path;
  return cwd === "/" ? `/${path}` : `${cwd}/${path}`;
};

/** Splits `-abc -d -- operands` into a flag set and the remaining operands. */
const splitFlags = (args: string[]) => {
  const flags = new Set<string>();
  let index = 0;
  for (; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") {
      index++;
      break;
    }
    if (!arg.startsWith("-") || arg.length === 1) break;
    for (const flag of arg.slice(1)) flags.add(flag);
  }
  return { flags, operands: args.slice(index) };
};

const echo: Program = ({ args, stdout }) => {
  const suppressNewline = args[0] === "-n";
  const words = suppressNewline ? args.slice(1) : args;
  stdout(words.join(" ") + (suppressNewline ? "" : "\n"));
  return 0;
};

const pwd: Program = ({ cwd, stdout }) => {
  stdout(`${cwd}\n`);
  return 0;
};

const cat: Program = ({ args, cwd, fs, stdout, stderr, stdin }) => {
  if (args.length === 0) {
    if (!stdin) return 0;
    return new Promise<number>((resolve) => {
      stdin.onData((chunk) => (chunk === null ? resolve(0) : stdout(chunk)));
    });
  }
  let status = 0;
  for (const file of args) {
    try {
      stdout(fs.readFile(absolute(cwd, file)));
    } catch (error) {
      stderr(`cat: ${file}: ${describe(error)}\n`);
      status = 1;
    }
  }
  return status;
};

const listEntries = (fs: IFsClient, path: string, showHidden: boolean) =>
  fs
    .readdir(path)
    .filter((name) => showHidden || !name.startsWith("."));

const ls: Program = ({ args, cwd, fs, stdout, stderr }) => {
  const { flags, operands } = splitFlags(args);
  const showHidden = flags.has("a");
  const targets = operands.length > 0 ? operands : ["."];
  const headers = targets.length > 1;
  let status = 0;
  let printed = false;

  for (const target of targets) {
    const path = absolute(cwd, target);
    try {
      if (fs.stat(path).kind !== "dir") {
        stdout(`${target}\n`);
        printed = true;
        continue;
      }
      if (printed) stdout("\n");
      if (headers) stdout(`${target}:\n`);
      for (const name of listEntries(fs, path, showHidden)) stdout(`${name}\n`);
      printed = true;
    } catch (error) {
      stderr(`ls: cannot access '${target}': ${describe(error)}\n`);
      status = 2;
    }
  }
  return status;
};

const mkdir: Program = ({ args, cwd, fs, stderr }) => {
  const { flags, operands } = splitFlags(args);
  if (operands.length === 0) {
    stderr("mkdir: missing operand\n");
    return 1;
  }
  let status = 0;
  for (const dir of operands) {
    try {
      fs.mkdir(absolute(cwd, dir), { recursive: flags.has("p") });
    } catch (error) {
      stderr(`mkdir: cannot create directory '${dir}': ${describe(error)}\n`);
      status = 1;
    }
  }
  return status;
};

const rm: Program = ({ args, cwd, fs, stderr }) => {
  const { flags, operands } = splitFlags(args);
  const recursive = flags.has("r") || flags.has("R");
  const force = flags.has("f");
  if (operands.length === 0) {
    if (force) return 0;
    stderr("rm: missing operand\n");
    return 1;
  }
  let status = 0;
  for (const path of operands) {
    try {
      fs.rm(absolute(cwd, path), { recursive });
    } catch (error) {
      if (force && errnoOf(error) === "ENOENT") continue;
      stderr(`rm: cannot remove '${path}': ${describe(error)}\n`);
      status = 1;
    }
  }
  return status;
};

const sleep: Program = async ({ args, sleep: wait, stderr }) => {
  const seconds = Number(args[0]);
  if (args.length !== 1 || !Number.isFinite(seconds) || seconds < 0) {
    stderr(`sleep: invalid time interval '${args[0] ?? ""}'\n`);
    return 1;
  }
  await wait(seconds * 1000);
  return 0;
};

const builtins: Record<string, Program> = {
  echo,
  pwd,
  cat,
  ls,
  mkdir,
  rm,
  sleep,
  node,
  true: () => 0,
  false: () => 1,
};

export { builtins };
export type { IProgramContext };
