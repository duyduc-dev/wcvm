import { ArrowsClockwiseIcon, FilePlusIcon, FolderPlusIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { basename, createEntry, deleteEntry, dirname, listDirectory, renameEntry } from "../controller/fs.service";
import type { DirEntry } from "../controller/types";
import { useIde } from "../controller/useIde";
import { ExplorerContext, type ExplorerActions, type ExplorerState } from "./context";
import { FileTreeItem } from "./FileTreeItem";
import { validateEntryName } from "./service";

export function Explorer() {
  const { c, snap } = useIde();
  const fs = c.fs;
  const rootPath = snap.rootPath;

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([rootPath]));
  const [children, setChildren] = useState<Record<string, DirEntry[]>>({});
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [creating, setCreating] = useState<{ dir: string; kind: "file" | "folder" } | null>(null);
  const [createValue, setCreateValue] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const loadDir = useCallback(
    async (path: string) => {
      const entries = await listDirectory(fs, path);
      setChildren((prev) => ({ ...prev, [path]: entries }));
    },
    [fs],
  );

  // `rootPath` never actually changes on a mounted instance — AppShell keys this component by
  // it, so a different project remounts Explorer fresh (all state, including `expanded`'s own
  // initializer, starts over) rather than resetting it here.
  useEffect(() => {
    // react-hooks/set-state-in-effect flags this as "setState in effect" purely because
    // `loadDir` can eventually call `setChildren` after its `await` — the standard, correct
    // fetch-on-mount pattern (React's own docs endorse it), not the derive-state-from-props
    // anti-pattern the rule exists to catch. The same rule already flags a pre-existing,
    // equally legitimate case in src/hooks/use-mobile.ts.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadDir(rootPath);
  }, [rootPath, loadDir]);

  const refresh = useCallback(() => {
    for (const path of expanded) void loadDir(path);
  }, [expanded, loadDir]);

  // The terminal (npm install, touch, git, a build...) changes files behind the Explorer's back:
  // IdeController bumps `fsRevision` while it produces output. Reload what is open - not on first
  // render (the effect above already loads the root) and not when only `expanded` changes.
  const fsRevision = snap.fsRevision;
  const lastRevision = useRef(fsRevision);
  useEffect(() => {
    if (lastRevision.current === fsRevision) return;
    lastRevision.current = fsRevision;
    refresh();
  }, [fsRevision, refresh]);

  const toggle = (entry: DirEntry) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(entry.path)) {
        next.delete(entry.path);
      } else {
        next.add(entry.path);
        if (children[entry.path] === undefined) void loadDir(entry.path);
      }
      return next;
    });
  };

  const startRename = (path: string, currentName: string) => {
    setRenaming(path);
    setRenameValue(currentName);
    setRenameError(null);
  };

  const commitRename = async () => {
    if (!renaming) return;
    const trimmed = renameValue.trim();
    if (trimmed === basename(renaming)) {
      setRenaming(null);
      return;
    }
    const error = validateEntryName(trimmed);
    if (error) {
      setRenameError(error);
      return;
    }
    try {
      const to = await renameEntry(fs, renaming, trimmed);
      c.renamePath(renaming, to);
      setRenaming(null);
      await loadDir(dirname(renaming));
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : "Rename failed");
    }
  };

  const startCreate = (dir: string, kind: "file" | "folder") => {
    setExpanded((prev) => new Set(prev).add(dir));
    if (children[dir] === undefined) void loadDir(dir);
    setCreating({ dir, kind });
    setCreateValue("");
    setCreateError(null);
  };

  const commitCreate = async () => {
    if (!creating) return;
    const trimmed = createValue.trim();
    const error = validateEntryName(trimmed);
    if (error) {
      setCreateError(error);
      return;
    }
    try {
      const path = await createEntry(fs, creating.dir, trimmed, creating.kind);
      const kind = creating.kind;
      const dir = creating.dir;
      setCreating(null);
      await loadDir(dir);
      if (kind === "file") void c.openFile(path);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Create failed");
    }
  };

  const confirmDeleteNow = async () => {
    if (!confirmDelete) return;
    const path = confirmDelete;
    setConfirmDelete(null);
    await deleteEntry(fs, path);
    if (snap.openTabs.includes(path)) c.closeTab(path);
    await loadDir(dirname(path));
  };

  const state: ExplorerState = {
    expanded,
    children,
    activePath: snap.activeTab,
    dirtyPaths: snap.dirty,
    renaming,
    renameValue,
    renameError,
    creating,
    createValue,
    createError,
  };
  const actions: ExplorerActions = {
    toggle,
    open: (entry) => void c.openFile(entry.path, { preview: true }),
    pin: (entry) => c.pinTab(entry.path),
    startRename,
    setRenameValue,
    commitRename: () => void commitRename(),
    cancelRename: () => setRenaming(null),
    startCreate,
    setCreateValue,
    commitCreate: () => void commitCreate(),
    cancelCreate: () => setCreating(null),
    requestDelete: setConfirmDelete,
  };

  const rootEntry: DirEntry = { name: snap.projectTitle, path: rootPath, dir: true };

  return (
    <div className="flex h-full flex-col bg-sidebar" data-tour="explorer">
      <div className="flex h-8 shrink-0 items-center justify-between border-b px-2">
        <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          Explorer
        </span>
        <div className="flex items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger
              onClick={() => startCreate(rootPath, "file")}
              className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <FilePlusIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipContent>New File</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              onClick={() => startCreate(rootPath, "folder")}
              className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <FolderPlusIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipContent>New Folder</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              onClick={refresh}
              className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <ArrowsClockwiseIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipContent>Refresh</TooltipContent>
          </Tooltip>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <ExplorerContext.Provider value={{ state, actions }}>
          <FileTreeItem entry={rootEntry} depth={0} />
        </ExplorerContext.Provider>
      </ScrollArea>

      <AlertDialog open={confirmDelete != null} onOpenChange={(open) => !open && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {confirmDelete ? basename(confirmDelete) : ""}?</AlertDialogTitle>
            <AlertDialogDescription>This can&apos;t be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmDeleteNow()}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
