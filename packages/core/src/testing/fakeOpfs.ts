import type { IOpfsDirHandle, IOpfsFileHandle } from "../fs/opfsPersistence";

const notFound = (): Error => Object.assign(new Error("NotFoundError"), { name: "NotFoundError" });
const typeMismatch = (): Error => Object.assign(new Error("TypeMismatchError"), { name: "TypeMismatchError" });

type FileNode = { kind: "file"; bytes: Uint8Array };
type DirNode = { kind: "directory"; children: Map<string, FileNode | DirNode> };
type Node = FileNode | DirNode;

const newDirNode = (): DirNode => ({ kind: "directory", children: new Map() });

/** Walks `path` from `root`, creating missing directories along the way only if `create`. */
const walk = (root: DirNode, path: string, create: boolean): DirNode | undefined => {
  let dir = root;
  for (const segment of path.split("/").filter(Boolean)) {
    const existing = dir.children.get(segment);
    if (existing?.kind === "directory") {
      dir = existing;
    } else if (!existing && create) {
      const created = newDirNode();
      dir.children.set(segment, created);
      dir = created;
    } else {
      return undefined;
    }
  }
  return dir;
};

const wrapFile = (node: FileNode): IOpfsFileHandle => ({
  kind: "file",
  getFile: async () => ({ arrayBuffer: async () => node.bytes.slice().buffer }),
  createWritable: async () => {
    let buffer = new Uint8Array(0);
    return {
      write: async (chunk: Uint8Array) => {
        const combined = new Uint8Array(buffer.length + chunk.length);
        combined.set(buffer);
        combined.set(chunk, buffer.length);
        buffer = combined;
      },
      close: async () => {
        node.bytes = buffer;
      },
    };
  },
});

const wrapDir = (node: DirNode): IOpfsDirHandle => ({
  kind: "directory",
  getDirectoryHandle: async (name, options) => {
    const existing = node.children.get(name);
    if (existing) {
      if (existing.kind !== "directory") throw typeMismatch();
      return wrapDir(existing);
    }
    if (!options?.create) throw notFound();
    const created = newDirNode();
    node.children.set(name, created);
    return wrapDir(created);
  },
  getFileHandle: async (name, options) => {
    const existing = node.children.get(name);
    if (existing) {
      if (existing.kind !== "file") throw typeMismatch();
      return wrapFile(existing);
    }
    if (!options?.create) throw notFound();
    const created: FileNode = { kind: "file", bytes: new Uint8Array(0) };
    node.children.set(name, created);
    return wrapFile(created);
  },
  removeEntry: async (name, options) => {
    const existing = node.children.get(name);
    if (!existing) throw notFound();
    if (existing.kind === "directory" && existing.children.size > 0 && !options?.recursive) {
      throw Object.assign(new Error("InvalidModificationError"), { name: "InvalidModificationError" });
    }
    node.children.delete(name);
  },
  entries: async function* () {
    for (const [name, child] of node.children) {
      yield [name, child.kind === "directory" ? wrapDir(child) : wrapFile(child)] as const;
    }
  },
});

export interface IFakeOpfsDir extends IOpfsDirHandle {
  /** Test helper: seeds a file directly (bypassing createWritable) - what OPFS already held
   *  before a restore, for restoreFromOpfs() tests. Creates missing parent directories. */
  seedFile(path: string, content: string | Uint8Array): void;
  /** Test helper: the current bytes of a file at `path`, or undefined if missing/not a file. */
  readFileAt(path: string): Uint8Array | undefined;
  /** Test helper: true if a directory (empty or not) exists at `path`. */
  hasDirAt(path: string): boolean;
}

export const createFakeOpfsDir = (): IFakeOpfsDir => {
  const root = newDirNode();
  return {
    ...wrapDir(root),
    seedFile: (path, content) => {
      const slash = path.lastIndexOf("/");
      const dir = walk(root, path.slice(0, slash) || "/", true)!;
      const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
      dir.children.set(path.slice(slash + 1), { kind: "file", bytes });
    },
    readFileAt: (path) => {
      const slash = path.lastIndexOf("/");
      const dir = walk(root, path.slice(0, slash) || "/", false);
      const entry = dir?.children.get(path.slice(slash + 1));
      return entry?.kind === "file" ? entry.bytes : undefined;
    },
    hasDirAt: (path) => walk(root, path, false) !== undefined,
  };
};
