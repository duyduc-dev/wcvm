import type { IWcvm } from "wcvm";
import type { EmbedView, IEmbedConfig, IEmbedPanes, IRunResult } from "@wcvm/sdk/protocol";
import { dirname } from "@/features/Editor/ide/controller/fs.service";

export const EMBED_PROJECT_ROOT = "/home/user/projects/embed";

const decoder = new TextDecoder();

/** Maps a host-supplied relative path into the project root; throws for anything that would
 *  escape it (`../x`, an absolute path to somewhere else). */
export function resolveProjectPath(relative: string): string {
  const parts: string[] = [];
  for (const part of relative.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (!parts.pop()) throw new Error(`Path escapes the project: ${relative}`);
      continue;
    }
    parts.push(part);
  }
  return [EMBED_PROJECT_ROOT, ...parts].join("/");
}

/** Replaces whatever is at the project root with `files`. */
export async function writeProject(wc: IWcvm, files: Record<string, string>): Promise<void> {
  await wc.fs.rm(EMBED_PROJECT_ROOT, { recursive: true }).catch(() => {});
  await wc.fs.mkdir(EMBED_PROJECT_ROOT, { recursive: true });
  for (const [relative, contents] of Object.entries(files)) {
    const path = resolveProjectPath(relative);
    await wc.fs.mkdir(dirname(path), { recursive: true });
    await wc.fs.writeFile(path, contents);
  }
}

export const readProjectFile = async (wc: IWcvm, path: string) =>
  decoder.decode(await wc.fs.readFile(resolveProjectPath(path)));

/** Runs `command` through `sh` in the project and collects stdout + stderr until it exits. */
export async function runCommand(wc: IWcvm, command: string): Promise<IRunResult> {
  const proc = await wc.spawn("sh", ["-c", command], { cwd: EMBED_PROJECT_ROOT });
  let output = "";
  const collect = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      output += dec.decode(value, { stream: true });
    }
  };
  const [exit] = await Promise.all([proc.exit, collect(proc.stdout), collect(proc.stderr)]);
  return { exitCode: exit.exitCode, output };
}

export interface IResolvedLayout {
  titleBar: boolean;
  activityBar: boolean;
  statusBar: boolean;
  explorer: boolean;
  terminal: boolean;
  editor: boolean;
  preview: boolean;
}

const VIEW_DEFAULTS: Record<EmbedView, IResolvedLayout> = {
  both: { titleBar: false, activityBar: false, statusBar: false, explorer: true, terminal: false, editor: true, preview: true },
  editor: { titleBar: false, activityBar: false, statusBar: false, explorer: true, terminal: false, editor: true, preview: false },
  preview: { titleBar: false, activityBar: false, statusBar: false, explorer: false, terminal: false, editor: false, preview: true },
};

/** `view` picks a preset; explicit `panes` entries override it. */
export function resolveLayout(view: EmbedView = "both", panes: IEmbedPanes = {}): IResolvedLayout {
  const base = VIEW_DEFAULTS[view] ?? VIEW_DEFAULTS.both;
  const pick = (key: keyof IEmbedPanes, fallback: boolean) => panes[key] ?? fallback;
  return {
    ...base,
    titleBar: pick("titleBar", base.titleBar),
    activityBar: pick("activityBar", base.activityBar),
    statusBar: pick("statusBar", base.statusBar),
    explorer: pick("explorer", base.explorer),
    terminal: pick("terminal", base.terminal),
  };
}

export const parseConfigFromSearch = (search: URLSearchParams): IEmbedConfig => {
  const view = search.get("view");
  const theme = search.get("theme");
  return {
    view: view === "editor" || view === "preview" || view === "both" ? view : undefined,
    theme: theme === "light" || theme === "dark" ? theme : undefined,
  };
};
