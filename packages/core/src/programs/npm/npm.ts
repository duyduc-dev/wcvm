// `npm` - a deliberately minimal one: only `npm install` (see install.ts for what that does and
// doesn't cover). Real npm is deferred (PLAN.md Phase 7); this exists so a project's dependencies
// (a Vite app's, say) can get into the VFS from the real registry at all.

import type { Program } from "../types";
import { install } from "./install";
import { DEFAULT_REGISTRY, NpmError, createRegistryClient, type IRegistryDeps } from "./registry";

export interface INpmDeps extends IRegistryDeps {
  now(): number;
}

const INSTALL_ALIASES = new Set(["install", "i", "add", "in", "isntall"]);

const USAGE = `Usage: npm install [<package>[@<version|range|tag>] ...] [--save-dev|-D] [--registry=<url>]

wcvm's npm only installs: from package.json with no arguments, or the named packages (saved to
package.json). No lockfile, no install scripts, no git/file/workspace dependencies.
`;

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

export const createNpm = (deps: INpmDeps): Program => async ({ args, cwd, env, fs, stdout, stderr }) => {
  const [command, ...rest] = args;
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    (command === undefined ? stderr : stdout)(USAGE);
    return command === undefined ? 1 : 0;
  }
  if (!INSTALL_ALIASES.has(command)) {
    stderr(`npm error "${command}" is not supported by wcvm's npm - only \`npm install\` is\n`);
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
    stdout(result.added ? `\nadded ${result.added} package${result.added === 1 ? "" : "s"} in ${took}\n` : `\nup to date in ${took}\n`);
    return 0;
  } catch (error) {
    if (error instanceof NpmError) stderr(`npm error code ${error.code}\nnpm error ${error.message}\n`);
    else stderr(`npm error ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
};
