export interface ISpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
}

export interface IState {
  processId: number;
}

export interface IProcessExit {
  errorCode: number;
  errorMessage?: string;
}

export interface IProcess {
  processId: number;
  exit: Promise<IProcessExit>;
}

export interface IFileNode {
  file: { contents: string | Uint8Array };
}
export interface IDirectoryNode {
  directory: FileSystemTree;
}
export interface ISymlinkNode {
  symlink: string;
}
/** A directory tree to seed the filesystem with in one call. */
export type FileSystemTree = Record<
  string,
  IFileNode | IDirectoryNode | ISymlinkNode
>;

export interface IStatResult {
  ino: number;
  kind: "file" | "dir" | "symlink";
  mode: number;
  size: number;
  nlink: number;
  mtimeMs: number;
  ctimeMs: number;
}
