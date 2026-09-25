// `npm run <script>` / `npm start|stop|restart|test`: runs a package.json script through
// wcvm's own `sh`, with every ancestor's `node_modules/.bin` prepended to PATH (`sh.ts`'s own
// `resolveExecutable` does the actual lookup) so a script can invoke a bin like `vite` the same
// way it would from a real shell. Not vendored (this isn't Node's own `lib/`, and real npm's own
// version pulls in native child_process spawning this sandbox doesn't have) - hand-written, but
// matched behavior-for-behavior against real npm 11 (banner format, the lifecycle-script listing,
// env vars, PATH construction, `start`'s `node server.js`/`restart`'s "stop && start" fallbacks)
// by reading `@npmcli/run-script`'s own source and running real npm side by side.

import type { IFsClient } from "../../fs/fsClient";
import type { IProgramContext } from "../types";
import { NpmError } from "./registry";

export interface IPackageForScripts {
  name?: string;
  version?: string;
  scripts?: Record<string, string>;
  config?: unknown;
  engines?: unknown;
  bin?: unknown;
}

const join = (...parts: string[]): string => parts.join("/").replaceAll(/\/+/g, "/");
const dirname = (path: string): string => path.slice(0, path.lastIndexOf("/")) || "/";

/** Throws the same simplified `ENOENT` `npm install` itself already uses for a missing
 *  package.json (real npm's own message here is a much longer syscall-shaped one - not matched,
 *  for the same "deliberately minimal" reason `install.ts`'s own ENOENT message isn't either). */
export const readPackageForScripts = (fs: IFsClient, cwd: string): IPackageForScripts => {
  const path = join(cwd, "package.json");
  try {
    return JSON.parse(new TextDecoder().decode(fs.readFile(path)));
  } catch {
    throw new NpmError("ENOENT", `Could not read package.json: no such file ${path}`);
  }
};

const pkgId = (pkg: IPackageForScripts): string | undefined => {
  if (!pkg.name) return undefined;
  return pkg.version ? `${pkg.name}@${pkg.version}` : pkg.name;
};

/** Real npm's own classification (`lib/commands/run.js`'s `cmdList`) for `npm run`'s listing -
 *  it only affects how the listing is grouped, never which scripts can actually run. */
const LIFECYCLE_NAMES = new Set([
  "prepare", "prepublishOnly", "prepack", "postpack", "dependencies",
  "preinstall", "install", "postinstall",
  "prepublish", "publish", "postpublish",
  "prerestart", "restart", "postrestart",
  "prestart", "start", "poststart",
  "prestop", "stop", "poststop",
  "pretest", "test", "posttest",
  "preuninstall", "uninstall", "postuninstall",
  "preversion", "version", "postversion",
]); // prettier-ignore

/** `npm run` with no script name: real npm's own two-section listing, byte-for-byte (checked
 *  against npm 11) - "" (no output at all) when there are no scripts, matching real npm exactly. */
export const listScripts = (pkg: IPackageForScripts): string => {
  const entries = Object.entries(pkg.scripts ?? {});
  if (entries.length === 0) return "";
  const cmds = entries.filter(([name]) => LIFECYCLE_NAMES.has(name));
  const rest = entries.filter(([name]) => !LIFECYCLE_NAMES.has(name));
  const id = pkgId(pkg);
  const idSuffix = id ? ` in ${id}` : "";
  const lines: string[] = [];
  if (cmds.length) {
    lines.push(`Lifecycle scripts included${idSuffix}:`);
    for (const [name, value] of cmds) lines.push(`  ${name}`, `    ${value}`);
  }
  if (rest.length) {
    lines.push(cmds.length ? "available via `npm run`:" : `Scripts available${idSuffix} via \`npm run\`:`);
    for (const [name, value] of rest) lines.push(`  ${name}`, `    ${value}`);
  }
  return `${lines.join("\n")}\n`;
};

/** `npm start`'s own fallback when there's no `start` script: real npm's `isServerPackage`. */
const isServerPackage = (fs: IFsClient, cwd: string): boolean => {
  try {
    return fs.stat(join(cwd, "server.js")).kind === "file";
  } catch {
    return false;
  }
};

/** Flattens package.json's `name`/`version`/`config`/`engines`/`bin` into `npm_package_*` env
 *  vars, matching real npm's own `@npmcli/run-script/lib/package-envs.js` (nested objects joined
 *  with `_`, arrays with `_<index>`, `null`/`false` -> empty string, everything else `String()`). */
const flattenPackageEnv = (values: Record<string, unknown>, prefix: string, env: Record<string, string>): void => {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    else if (value === null || value === false) env[`${prefix}${key}`] = "";
    else if (Array.isArray(value)) value.forEach((item, index) => flattenPackageEnv({ [`${key}_${index}`]: item }, prefix, env));
    else if (typeof value === "object") flattenPackageEnv(value as Record<string, unknown>, `${prefix}${key}_`, env);
    else env[`${prefix}${key}`] = String(value as string | number | boolean | bigint | symbol);
  }
};

const packageEnvs = (pkg: IPackageForScripts): Record<string, string> => {
  const env: Record<string, string> = {};
  flattenPackageEnv({ name: pkg.name, version: pkg.version, config: pkg.config, engines: pkg.engines, bin: pkg.bin }, "npm_package_", env);
  return env;
};

/** Every ancestor's `node_modules/.bin`, nearest first, down to the root - real npm's own
 *  `@npmcli/run-script/lib/set-path.js` builds it the same way (walking `dirname()` to the root). */
const binDirsFrom = (cwd: string): string[] => {
  const dirs: string[] = [];
  for (let dir = cwd; ; ) {
    dirs.push(join(dir, "node_modules/.bin"));
    const parent = dirname(dir);
    if (parent === dir) return dirs;
    dir = parent;
  }
};

const buildScriptEnv = (baseEnv: Record<string, string>, cwd: string, pkg: IPackageForScripts, event: string, cmd: string): Record<string, string> => ({
  ...baseEnv,
  ...packageEnvs(pkg),
  PATH: [...binDirsFrom(cwd), baseEnv.PATH].filter(Boolean).join(":"),
  npm_package_json: join(cwd, "package.json"),
  npm_lifecycle_event: event,
  npm_lifecycle_script: cmd,
});

/** `\n> <pkg id> <event>\n> <cmd> [args]\n\n` - byte-for-byte real npm's own banner
 *  (`@npmcli/run-script/lib/run-script-pkg.js`), checked against npm 11. */
const banner = (pkg: IPackageForScripts, event: string, cmd: string, args: string[]): string => {
  const id = pkgId(pkg);
  const idPrefix = id ? `${id} ` : "";
  const argsSuffix = args.length ? ` ${args.join(" ")}` : "";
  const header = `\n> ${idPrefix}${event}\n`;
  const command = `> ${cmd.trim().replaceAll("\n", "\n> ")}${argsSuffix}\n`;
  return `${header}${command}\n`;
};

const runOne = async (ctx: IProgramContext, pkg: IPackageForScripts, event: string, cmd: string, args: string[]): Promise<number> => {
  ctx.stdout(banner(pkg, event, cmd, args));
  const finalCommand = args.length ? `${cmd} ${args.join(" ")}` : cmd;
  // Loaded lazily, like `node.ts`'s own runtime import: a static import here would make this
  // module (and so `npm.ts`) part of the very builtins-registry cycle `sh.ts` already has with
  // `builtins.ts` (which EAGERLY calls `createNpm(...)` at its own module-load time) - reached
  // through a different edge, that cycle can leave `createNpm` itself not yet defined when
  // `builtins.ts` tries to call it. A dynamic import here runs long after every module (this one
  // included) has finished loading, so it never participates in that cycle at all.
  const { sh } = await import("../sh/sh");
  return sh({ ...ctx, args: ["-c", finalCommand], env: buildScriptEnv(ctx.env, ctx.cwd, pkg, event, cmd) });
};

export interface IRunScriptOptions {
  ifPresent: boolean;
  ignoreScripts: boolean;
}

/**
 * Runs `pkg.scripts[event]` (plus `pre<event>`/`post<event>`, unless `ignoreScripts`), the way
 * `npm run <event>`/`npm start`/`npm stop`/`npm restart`/`npm test` do: a `pre`/main/`post`
 * failure stops the sequence right there (checked against npm 11 - a failing script's exit code
 * is relayed as-is, with no extra "npm error" wrapping around it). Throws a plain `Error` (no
 * error `code` - matching real npm, which doesn't give this one either) if `event` isn't defined
 * and there's no fallback for it, unless `ifPresent`.
 */
export const runNpmScript = async (ctx: IProgramContext, pkg: IPackageForScripts, event: string, args: string[], options: IRunScriptOptions): Promise<number> => {
  const scripts = pkg.scripts ?? {};
  let cmd = scripts[event];
  if (cmd === undefined && event === "restart") cmd = "npm stop --if-present && npm start";
  else if (cmd === undefined && event === "start" && isServerPackage(ctx.fs, ctx.cwd)) cmd = "node server.js";

  if (cmd === undefined) {
    if (options.ifPresent) return 0;
    throw new Error([`Missing script: "${event}"`, "", "To see a list of scripts, run:", "  npm run"].join("\n"));
  }

  const pre = options.ignoreScripts ? undefined : scripts[`pre${event}`];
  const post = options.ignoreScripts ? undefined : scripts[`post${event}`];
  if (pre !== undefined) {
    const status = await runOne(ctx, pkg, `pre${event}`, pre, []);
    if (status !== 0) return status;
  }
  const status = await runOne(ctx, pkg, event, cmd, args);
  if (status !== 0) return status;
  return post !== undefined ? runOne(ctx, pkg, `post${event}`, post, []) : 0;
};
