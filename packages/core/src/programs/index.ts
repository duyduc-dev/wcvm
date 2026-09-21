import { builtins } from "./builtins";
import type { Program } from "./types";

/** Finds a built-in by bare name or `/bin/<name>`; undefined if there is none. */
const resolveProgram = (command: string): Program | undefined => {
  const name = command.startsWith("/bin/") ? command.slice("/bin/".length) : command;
  return Object.hasOwn(builtins, name) ? builtins[name] : undefined;
};

export { resolveProgram };
export type { IProgramContext, Program } from "./types";
