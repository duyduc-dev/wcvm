import { GlobeIcon, PlusIcon, XIcon } from "@phosphor-icons/react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useIde } from "../../controller/useIde";

export function PreviewTabStrip() {
  const { c, snap } = useIde();
  const tabs = snap.previewTabs;

  return (
    <div className="flex h-8 shrink-0 items-stretch border-b bg-[#f3f3f3] dark:bg-[#181818]">
      <div className="flex flex-1 items-stretch overflow-x-auto">
        {tabs.map((t) => {
          const isActive = t.id === snap.activePreviewId;
          const title = t.title ?? (t.port != null ? `Preview (${t.port})` : "New Tab");
          return (
            <div
              key={t.id}
              title={title}
              onClick={() => c.activatePreviewTab(t.id)}
              className={cn(
                "group flex cursor-pointer items-center gap-1.5 border-r px-3 text-xs",
                isActive
                  ? "bg-sidebar text-foreground"
                  : "bg-[#f3f3f3] text-muted-foreground hover:text-foreground dark:bg-[#181818]",
              )}
            >
              <GlobeIcon className="size-3.5 shrink-0 opacity-70" />
              <span className="max-w-32 truncate">{title}</span>
              <button
                title="Close"
                className="flex size-4 items-center justify-center rounded hover:bg-accent"
                onClick={(e) => {
                  e.stopPropagation();
                  c.closePreviewTab(t.id);
                }}
              >
                <XIcon className={cn("size-3", isActive ? "block" : "hidden group-hover:block")} />
              </button>
            </div>
          );
        })}
      </div>
      <Tooltip>
        <TooltipTrigger
          onClick={() => c.addPreviewTab()}
          aria-label="New browser tab"
          className="flex w-8 shrink-0 items-center justify-center border-l text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <PlusIcon className="size-4" />
        </TooltipTrigger>
        <TooltipContent>New browser tab</TooltipContent>
      </Tooltip>
    </div>
  );
}
