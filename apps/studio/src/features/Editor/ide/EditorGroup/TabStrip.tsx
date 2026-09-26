import { XIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { basename } from "../controller/fs.service";
import { useIde } from "../controller/useIde";
import { FileIcon } from "../fileIcon";

interface TabStripProps {
  onRequestClose: (path: string) => void;
}

export function TabStrip({ onRequestClose }: TabStripProps) {
  const { c, snap } = useIde();

  return (
    <div className="ide-tabs-scroll flex h-9 shrink-0 items-stretch overflow-x-auto border-b bg-[#f3f3f3] dark:bg-[#181818]">
      {snap.openTabs.map((path) => {
        const active = path === snap.activeTab;
        const isDirty = snap.dirty.includes(path);
        const isPreview = path === snap.previewTab;
        return (
          <div
            key={path}
            title={path}
            onClick={() => void c.openFile(path, { preview: isPreview })}
            onDoubleClick={() => c.pinTab(path)}
            onAuxClick={(e) => {
              if (e.button !== 1) return;
              e.preventDefault();
              onRequestClose(path);
            }}
            className={cn(
              "group flex cursor-pointer items-center gap-1.5 border-r px-3 text-xs",
              active
                ? "bg-white text-foreground shadow-[inset_0_2px_0_0_#007acc] dark:bg-[#1e1e1e]"
                : "bg-[#f3f3f3] text-muted-foreground hover:text-foreground dark:bg-[#181818]",
            )}
          >
            <FileIcon name={basename(path)} className="size-3.5 shrink-0" />
            <span className={cn(isPreview && "italic")}>{basename(path)}</span>
            <button
              className="flex size-4 items-center justify-center rounded hover:bg-accent"
              onClick={(e) => {
                e.stopPropagation();
                onRequestClose(path);
              }}
              title="Close"
            >
              {isDirty ? (
                <>
                  <span className="size-2 rounded-full bg-foreground group-hover:hidden" />
                  <XIcon className="hidden size-3 group-hover:block" />
                </>
              ) : (
                <XIcon className={cn("size-3", active ? "block" : "hidden group-hover:block")} />
              )}
            </button>
          </div>
        );
      })}
    </div>
  );
}
