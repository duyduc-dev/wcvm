// `npm` - a deliberately minimal one: `npm install` (see install.ts for what that does and
// doesn't cover) and `npm run`/`start`/`stop`/`restart`/`test` (see runScript.ts). Real npm is
// deferred (PLAN.md Phase 7); this exists so a project's dependencies (a Vite app's, say) can get
// into the VFS from the real registry, and its scripts actually run, at all.

import { node } from "../node";
import type { IProgramContext, Program } from "../types";
import { mangleCreateName, resolvePackageBin } from "./exec";
import { install, parseCommandLineSpec } from "./install";
import { DEFAULT_REGISTRY, NpmError, createRegistryClient, type IRegistryDeps } from "./registry";
import { type IPackageForScripts, listScripts, readPackageForScripts, runNpmScript } from "./runScript";

export interface INpmDeps extends IRegistryDeps {
  now(): number;
}

const INSTALL_ALIASES = new Set(["install", "i", "add", "in", "isntall"]);
// Real npm's own aliases (lib/utils/cmd-list.js): `run-script`/`rum`/`urn` -> run; `t`/`tst` -> test.
const RUN_ALIASES = new Set(["run", "run-script", "rum", "urn"]);
const LIFECYCLE_EVENTS: Record<string, string> = { start: "start", stop: "stop", restart: "restart", test: "test", t: "test", tst: "test" };
// Real npm's own alias (cmd-list.js): `create` -> `init`.
const CREATE_ALIASES = new Set(["create", "init"]);

const USAGE = `Usage: npm install [<package>[@<version|range|tag>] ...] [--save-dev|-D] [--registry=<url>]
       npm run [<script>] [-- <args>...] [--if-present] [--ignore-scripts]
       npm start|stop|restart|test [-- <args>...] [--if-present] [--ignore-scripts]
       npm create <name>[@<version>] [-- <args>...]  (same as \`npm init <name> ...\`)

wcvm's npm only installs (from package.json with no arguments, or the named packages, saved to
package.json - no lockfile, no install scripts, no git/file/workspace dependencies), runs
package.json scripts (no workspaces; \`--if-present\`/\`--ignore-scripts\` are the only run flags),
and creates: \`npm create <name>\` fetches "create-<name>" (real npm's own mangling) and runs its
own bin, like \`npx create-<name>\` - bare \`npm init\` (real npm's interactive wizard) isn't.
`;

/** Strips the first bare `--` (everything else is untouched) - real npm's own CLI parsing
 *  consumes it the same way before a created package's own args ever see it, and this sandbox's
 *  npm has no flags of its own to recognize among an initializer's trailing args. */
const stripFirstDashDash = (args: string[]): string[] => {
  const index = args.indexOf("--");
  return index === -1 ? args : [...args.slice(0, index), ...args.slice(index + 1)];
};

/** Strips `--if-present`/`--ignore-scripts` (recognized anywhere before a `--`) and the first
 *  bare `--` itself, matching how npm's own CLI parsing stops recognizing flags after it. */
const extractRunFlags = (args: string[]): { rest: string[]; ifPresent: boolean; ignoreScripts: boolean } => {
  let ifPresent = false;
  let ignoreScripts = false;
  let sawDashDash = false;
  const rest: string[] = [];
  for (const arg of args) {
    if (!sawDashDash && arg === "--") sawDashDash = true;
    else if (!sawDashDash && arg === "--if-present") ifPresent = true;
    else if (!sawDashDash && arg === "--ignore-scripts") ignoreScripts = true;
    else rest.push(arg);
  }
  return { rest, ifPresent, ignoreScripts };
};

/** Every line of a thrown error, each prefixed "npm error " like real npm's own CLI does (not
 *  just the first line - a multi-line message, like a missing-script error, needs every line
 *  prefixed the same way). */
const reportError = (stderr: (data: string) => void, error: unknown): number => {
  let text: string;
  if (error instanceof NpmError) text = `code ${error.code}\n${error.message}`;
  else if (error instanceof Error) text = error.message;
  else text = String(error);
  const prefixed = text.split("\n").map((line) => `npm error ${line}`).join("\n");
  stderr(`${prefixed}\n`);
  return 1;
};

/** Everything `npm run`/`run-script`/`rum`/`urn`/`start`/`stop`/`restart`/`test`/`t`/`tst` needs
 *  (kept out of `createNpm`'s own dispatch, which only decides WHICH of the two command families
 *  a call belongs to). */
const runCommand = async (ctx: IProgramContext, command: string, rest: string[]): Promise<number> => {
  const { cwd, fs, stdout, stderr } = ctx;
  const { rest: filtered, ifPresent, ignoreScripts } = extractRunFlags(rest);
  const isNamedRun = RUN_ALIASES.has(command);
  const event = isNamedRun ? filtered[0] : LIFECYCLE_EVENTS[command];
  const scriptArgs = isNamedRun ? filtered.slice(1) : filtered;

  let pkg: IPackageForScripts;
  try {
    pkg = readPackageForScripts(fs, cwd);
  } catch (error) {
    return reportError(stderr, error);
  }
  if (event === undefined) {
    stdout(listScripts(pkg));
    return 0;
  }
  try {
    return await runNpmScript(ctx, pkg, event, scriptArgs, { ifPresent, ignoreScripts });
  } catch (error) {
    return reportError(stderr, error);
  }
};

/** `npm create <name>`/`npm init <name>`: resolves "create-<name>" (real npm's own mangling,
 *  `exec.ts`'s `mangleCreateName`) from the registry and runs its own `bin` through `node`, with
 *  this process's own argv/cwd/stdio - the same "npx <pkg>" idea real npm's `npm exec` implements.
 *  A bare `npm init` (real npm's interactive package.json wizard) isn't supported. */
const runCreate = async (ctx: IProgramContext, deps: INpmDeps, command: string, rest: string[]): Promise<number> => {
  const { env, fs, stderr } = ctx;
  const [initializer, ...rawArgs] = rest;
  if (initializer === undefined) {
    stderr(`npm error "npm ${command}" with no package name isn't supported by wcvm's npm - only \`npm create <name>\`/\`npm init <name>\` (running that package's own bin) are\n`);
    return 1;
  }
  const registryUrl = env.npm_config_registry ?? env.NPM_CONFIG_REGISTRY ?? DEFAULT_REGISTRY;
  const registry = createRegistryClient(registryUrl, deps);
  const { name, spec: versionSpec } = parseCommandLineSpec(initializer);
  const mangled = mangleCreateName(name);
  try {
    const resolved = await resolvePackageBin(fs, registry, versionSpec ? `${mangled}@${versionSpec}` : mangled);
    return await node({ ...ctx, args: [resolved.binPath, ...stripFirstDashDash(rawArgs)] });
  } catch (error) {
    return reportError(stderr, error);
  }
};

const formatDuration = (ms: number): string => (ms < 1000 ? `${Math.round(ms)}ms` : `${Math.round(ms / 1000)}s`);

interface IInstallArgs {
  specs: string[];
  saveDev: boolean;
  registry?: string;
  ignored: string[];
}

const parseInstallArgs = (args: string[]): IInstallArgs => {
  const parsed: IInstallArgs = { specs: [], saveDev: false, ignored: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--save-dev" || arg === "-D") parsed.saveDev = true;
    else if (arg === "--save" || arg === "-S" || arg === "--save-prod" || arg === "-P") parsed.saveDev = false;
    else if (arg.startsWith("--registry=")) parsed.registry = arg.slice("--registry=".length);
    else if (arg === "--registry") parsed.registry = args[++i];
    else if (arg.startsWith("-")) parsed.ignored.push(arg);
    else parsed.specs.push(arg);
  }
  return parsed;
};

export const createNpm = (deps: INpmDeps): Program => async (ctx) => {
  const { args, cwd, env, fs, stdout, stderr } = ctx;
  const [command, ...rest] = args;
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    (command === undefined ? stderr : stdout)(USAGE);
    return command === undefined ? 1 : 0;
  }

  if (RUN_ALIASES.has(command) || Object.hasOwn(LIFECYCLE_EVENTS, command)) return runCommand(ctx, command, rest);

  if (CREATE_ALIASES.has(command)) return runCreate(ctx, deps, command, rest);

  if (!INSTALL_ALIASES.has(command)) {
    stderr(`npm error "${command}" is not supported by wcvm's npm - only \`npm install\`, \`npm run\` and \`npm create\` are\n`);
    return 1;
  }

  const options = parseInstallArgs(rest);
  for (const flag of options.ignored) stderr(`npm warn ignoring unsupported option ${flag}\n`);
  const registryUrl = options.registry ?? env.npm_config_registry ?? env.NPM_CONFIG_REGISTRY ?? DEFAULT_REGISTRY;
  const start = deps.now();
  try {
    const result = await install({
      fs,
      cwd,
      registry: createRegistryClient(registryUrl, deps),
      add: options.specs,
      saveDev: options.saveDev,
      warn: (message) => stderr(`npm warn ${message}\n`),
    });
    if (result.skippedScripts.length) {
      stderr(`npm warn install scripts were not run (wcvm's npm never runs them): ${result.skippedScripts.join(", ")}\n`);
    }
    const took = formatDuration(deps.now() - start);
    if (result.added) {
      const plural = result.added === 1 ? "" : "s";
      stdout(`\nadded ${result.added} package${plural} in ${took}\n`);
    } else {
      stdout(`\nup to date in ${took}\n`);
    }
    return 0;
  } catch (error) {
    return reportError(stderr, error);
  }
};
