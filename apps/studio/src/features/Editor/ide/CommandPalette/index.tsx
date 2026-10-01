import {
  FloppyDiskIcon,
  MagicWandIcon,
  MoonIcon,
  PlusIcon,
  SidebarSimpleIcon,
  TerminalWindowIcon,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { basename, collectFiles } from "../controller/fs.service";
import { useIde } from "../controller/useIde";
import type { IdeController } from "../controller/IdeController";
import { FileIcon } from "../fileIcon";
import { COMMANDS, QUICK_OPEN_RESULT_LIMIT, type CommandId } from "./constants";

const ICON_BY_COMMAND: Record<CommandId, React.ComponentType<{ className?: string }>> = {
  "toggle-explorer": SidebarSimpleIcon,
  "toggle-terminal": TerminalWindowIcon,
  "toggle-preview": SidebarSimpleIcon,
  "new-terminal": PlusIcon,
  "save-file": FloppyDiskIcon,
  "format-document": MagicWandIcon,
  "toggle-theme": MoonIcon,
};

function runCommand(id: CommandId, c: IdeController): void {
  switch (id) {
    case "toggle-explorer":
      return c.toggleSidebar();
    case "toggle-terminal":
      return c.togglePanel();
    case "toggle-preview":
      return c.togglePreview();
    case "new-terminal":
      void c.newShellTerminal();
      return;
    case "save-file":
      return c.saveActiveFile();
    case "format-document":
      void c.formatActiveDocument();
      return;
    case "toggle-theme":
      return c.toggleTheme();
  }
}

export function CommandPalette() {
  const { c, snap } = useIde();
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const isFileMode = snap.paletteMode === "file";

  // Reset the typed query the moment the palette (re-)opens — adjusted during render (React's
  // own recommended way to reset state on a prop/store change) rather than in an effect, so
  // there's no stale-query frame in between.
  const [wasOpen, setWasOpen] = useState(snap.paletteOpen);
  if (snap.paletteOpen !== wasOpen) {
    setWasOpen(snap.paletteOpen);
    if (snap.paletteOpen) setQuery("");
  }

  useEffect(() => {
    if (!snap.paletteOpen || !isFileMode) return;
    void collectFiles(c.fs, snap.rootPath).then(setFiles);
  }, [c, snap.paletteOpen, isFileMode, snap.rootPath]);

  const filteredFiles = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = needle ? files.filter((path) => path.toLowerCase().includes(needle)) : files;
    return list.slice(0, QUICK_OPEN_RESULT_LIMIT);
  }, [files, query]);

  const run = (fn: () => void) => {
    c.closePalette();
    fn();
  };

  return (
    <CommandDialog open={snap.paletteOpen} onOpenChange={(open) => !open && c.closePalette()}>
      <Command shouldFilter={!isFileMode}>
        <CommandInput
          value={query}
          onValueChange={setQuery}
          placeholder={isFileMode ? "Search files by name…" : "Type a command…"}
        />
        <CommandList>
          <CommandEmpty>No results.</CommandEmpty>
          {isFileMode ? (
            <CommandGroup heading="Files">
              {filteredFiles.map((path) => (
                <CommandItem key={path} value={path} onSelect={() => run(() => void c.openFile(path))}>
                  <FileIcon name={basename(path)} className="size-4" />
                  <span>{basename(path)}</span>
                  <span className="ml-auto text-xs text-muted-foreground">{path}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          ) : (
            <CommandGroup heading="Commands">
              {COMMANDS.map((cmd) => {
                const Icon = ICON_BY_COMMAND[cmd.id];
                return (
                  <CommandItem key={cmd.id} value={cmd.label} onSelect={() => run(() => runCommand(cmd.id, c))}>
                    <Icon className="size-4" /> {cmd.label}
                    {cmd.keys && <span className="ml-auto text-xs text-muted-foreground">{cmd.keys}</span>}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
