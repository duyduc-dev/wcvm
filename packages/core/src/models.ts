export interface ISpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
}

export interface IState {
  processId: number;
}

export interface IProcessExit {
  /** The process's exit status (143 / 137 when killed by SIGTERM / SIGKILL). */
  exitCode: number;
  errorMessage?: string;
  signal?: "SIGTERM" | "SIGKILL";
}

export interface IProcess {
  processId: number;
  /** Bytes the process wrote; closes when it exits. Buffers until read. */
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exit: Promise<IProcessExit>;
  /** Stops the process; a no-op once it has exited. Defaults to SIGTERM. */
  kill(signal?: "SIGTERM" | "SIGKILL"): void;
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
