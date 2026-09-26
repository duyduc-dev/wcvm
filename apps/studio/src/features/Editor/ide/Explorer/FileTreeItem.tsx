import { CaretRightIcon } from "@phosphor-icons/react";
import { useEffect, useRef } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import type { DirEntry } from "../controller/types";
import { FileIcon, FolderIcon } from "../fileIcon";
import { useExplorer } from "./context";
import { INDENT_PX, ROW_HEIGHT_PX } from "./constants";

function NameInput({
  value,
  error,
  onChange,
  onCommit,
  onCancel,
}: {
  value: string;
  error: string | null;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <div className="flex-1">
      <input
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Enter") onCommit();
          else if (e.key === "Escape") onCancel();
          e.stopPropagation();
        }}
        onBlur={onCommit}
        className={cn(
          "w-full rounded-none border bg-background px-1 text-xs outline-none",
          error ? "border-destructive" : "border-ring",
        )}
      />
      {error && <div className="px-1 text-[11px] text-destructive">{error}</div>}
    </div>
  );
}

interface FileTreeItemProps {
  entry: DirEntry;
  depth: number;
}

export function FileTreeItem({ entry, depth }: FileTreeItemProps) {
  const { state, actions } = useExplorer();
  const isExpanded = entry.dir && state.expanded.has(entry.path);
  const isRenaming = state.renaming === entry.path;
  const isActive = state.activePath === entry.path;
  const isDirty = state.dirtyPaths.includes(entry.path);
  const childEntries = state.children[entry.path];
  const creatingHere = state.creating?.dir === entry.path ? state.creating : null;
  const paddingLeft = 8 + depth * INDENT_PX;

  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger className="contents">
          <div
            role="button"
            tabIndex={0}
            style={{ height: ROW_HEIGHT_PX, paddingLeft }}
            onClick={() => (entry.dir ? actions.toggle(entry) : actions.open(entry))}
            onDoubleClick={() => !entry.dir && actions.pin(entry)}
            className={cn(
              "flex items-center gap-1 pr-2 text-xs whitespace-nowrap",
              isActive ? "bg-accent text-foreground" : "text-foreground/90 hover:bg-accent/60",
            )}
          >
            {entry.dir ? (
              <CaretRightIcon
                className={cn("size-3 shrink-0 text-muted-foreground transition-transform", isExpanded && "rotate-90")}
              />
            ) : (
              <span className="inline-block size-3 shrink-0" />
            )}
            {entry.dir ? (
              <FolderIcon open={isExpanded} className="size-3.5 shrink-0" />
            ) : (
              <FileIcon name={entry.name} className="size-3.5 shrink-0" />
            )}
            {isRenaming ? (
              <NameInput
                value={state.renameValue}
                error={state.renameError}
                onChange={actions.setRenameValue}
                onCommit={actions.commitRename}
                onCancel={actions.cancelRename}
              />
            ) : (
              <span className="truncate">{entry.name}</span>
            )}
            {isDirty && !isRenaming && <span className="ml-auto size-1.5 shrink-0 rounded-full bg-foreground" />}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-44">
          {entry.dir && (
            <>
              <ContextMenuItem onClick={() => actions.startCreate(entry.path, "file")}>New File</ContextMenuItem>
              <ContextMenuItem onClick={() => actions.startCreate(entry.path, "folder")}>New Folder</ContextMenuItem>
              <ContextMenuSeparator />
            </>
          )}
          <ContextMenuItem onClick={() => actions.startRename(entry.path, entry.name)}>Rename</ContextMenuItem>
          <ContextMenuItem variant="destructive" onClick={() => actions.requestDelete(entry.path)}>
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {entry.dir && isExpanded && (
        <div>
          {childEntries === undefined ? (
            <div
              style={{ height: ROW_HEIGHT_PX, paddingLeft: paddingLeft + INDENT_PX }}
              className="flex items-center text-xs text-muted-foreground"
            >
              Loading…
            </div>
          ) : (
            childEntries.map((child) => <FileTreeItem key={child.path} entry={child} depth={depth + 1} />)
          )}
          {creatingHere && (
            <div
              style={{ height: ROW_HEIGHT_PX, paddingLeft: paddingLeft + INDENT_PX }}
              className="flex items-center gap-1 pr-2"
            >
              <span className="inline-block size-3 shrink-0" />
              {creatingHere.kind === "folder" ? (
                <FolderIcon className="size-3.5 shrink-0" />
              ) : (
                <FileIcon name={state.createValue || "untitled"} className="size-3.5 shrink-0" />
              )}
              <NameInput
                value={state.createValue}
                error={state.createError}
                onChange={actions.setCreateValue}
                onCommit={actions.commitCreate}
                onCancel={actions.cancelCreate}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
