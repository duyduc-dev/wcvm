import { createContext, useContext } from "react";
import type { DirEntry } from "../controller/types";

export interface ExplorerState {
  expanded: Set<string>;
  children: Record<string, DirEntry[]>;
  activePath: string | null;
  dirtyPaths: string[];
  renaming: string | null;
  renameValue: string;
  renameError: string | null;
  creating: { dir: string; kind: "file" | "folder" } | null;
  createValue: string;
  createError: string | null;
}

export interface ExplorerActions {
  toggle(entry: DirEntry): void;
  open(entry: DirEntry): void;
  pin(entry: DirEntry): void;
  startRename(path: string, currentName: string): void;
  setRenameValue(value: string): void;
  commitRename(): void;
  cancelRename(): void;
  startCreate(dir: string, kind: "file" | "folder"): void;
  setCreateValue(value: string): void;
  commitCreate(): void;
  cancelCreate(): void;
  requestDelete(path: string): void;
}

export const ExplorerContext = createContext<{ state: ExplorerState; actions: ExplorerActions } | null>(
  null,
);

export function useExplorer() {
  const ctx = useContext(ExplorerContext);
  if (!ctx) throw new Error("useExplorer must be used within Explorer");
  return ctx;
}
