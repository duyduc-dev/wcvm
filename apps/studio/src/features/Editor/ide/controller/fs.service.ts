import type { IFs } from "wcvm";
import {
  HIDDEN_IN_QUICK_OPEN,
  HIDDEN_IN_TREE,
  IMAGE_EXTENSIONS,
  QUICK_OPEN_FILE_LIMIT,
} from "./constants";
import type { DirEntry, TabKind } from "./types";

export const joinPath = (dir: string, name: string) =>
  dir === "/" ? `/${name}` : `${dir}/${name}`;

export const basename = (path: string) => path.split("/").filter(Boolean).pop() ?? path;

export const dirname = (path: string) => {
  const idx = path.lastIndexOf("/");
  return idx <= 0 ? "/" : path.slice(0, idx);
};

export const extensionOf = (path: string) => {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

/** `abs` relative to `root`, for display (breadcrumbs, tab titles never need this — they use
 * `basename` — but the Explorer's implicit root row and any future breadcrumb do). */
export const relativeTo = (root: string, abs: string) =>
  abs === root ? basename(root) : abs.slice(root.length + 1);

export const isImagePath = (path: string) => IMAGE_EXTENSIONS.has(extensionOf(path));

export const tabKindFor = (path: string): TabKind => (isImagePath(path) ? "image" : "text");

const MIME_BY_EXTENSION: Record<string, string> = {
  svg: "image/svg+xml",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
};

export const mimeTypeFor = (path: string): string =>
  MIME_BY_EXTENSION[extensionOf(path)] ?? "application/octet-stream";

/** One directory level, files and folders together, folders first then alphabetical — `readdir`
 * only returns names, so each entry needs its own `stat` to know whether it's a directory. An
 * entry that fails to stat (e.g. removed mid-listing) is silently dropped rather than thrown. */
export async function listDirectory(fs: IFs, path: string): Promise<DirEntry[]> {
  const names = await fs.readdir(path);
  const entries = await Promise.all(
    names
      .filter((name) => !HIDDEN_IN_TREE.has(name))
      .map(async (name): Promise<DirEntry | null> => {
        const entryPath = joinPath(path, name);
        try {
          const info = await fs.stat(entryPath);
          return { name, path: entryPath, dir: info.kind === "dir" };
        } catch {
          return null;
        }
      }),
  );
  return entries
    .filter((entry): entry is DirEntry => entry !== null)
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
}

export async function readTextFile(fs: IFs, path: string): Promise<string> {
  const bytes = await fs.readFile(path);
  return new TextDecoder().decode(bytes);
}

export const writeTextFile = (fs: IFs, path: string, contents: string) =>
  fs.writeFile(path, contents);

export async function createEntry(
  fs: IFs,
  dir: string,
  name: string,
  kind: "file" | "folder",
): Promise<string> {
  const path = joinPath(dir, name);
  if (await fs.exists(path)) {
    throw new Error(`"${name}" already exists`);
  }
  if (kind === "folder") {
    await fs.mkdir(path);
  } else {
    await fs.writeFile(path, "");
  }
  return path;
}

export async function renameEntry(fs: IFs, from: string, toName: string): Promise<string> {
  const to = joinPath(dirname(from), toName);
  if (to !== from && (await fs.exists(to))) {
    throw new Error(`"${toName}" already exists`);
  }
  await fs.rename(from, to);
  return to;
}

export const deleteEntry = (fs: IFs, path: string) => fs.rm(path, { recursive: true });

/** Flat file list under `root` for quick-open (⌘P), depth-first, capped at
 * `QUICK_OPEN_FILE_LIMIT` so a huge `node_modules`-adjacent tree can't hang the palette. */
export async function collectFiles(fs: IFs, root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    if (out.length >= QUICK_OPEN_FILE_LIMIT) return;
    const entries = await listDirectory(fs, dir);
    for (const entry of entries) {
      if (out.length >= QUICK_OPEN_FILE_LIMIT) return;
      if (entry.dir) {
        if (HIDDEN_IN_QUICK_OPEN.has(entry.name)) continue;
        await walk(entry.path);
      } else {
        out.push(entry.path);
      }
    }
  };
  await walk(root);
  return out;
}
