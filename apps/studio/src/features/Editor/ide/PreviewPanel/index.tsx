import { GlobeIcon, PlusIcon, XIcon } from "@phosphor-icons/react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useIde } from "../controller/useIde";
import { PreviewFrame } from "./PreviewFrame";
import { PreviewToolbar } from "./PreviewToolbar";

export function PreviewPanel() {
  const { c, snap } = useIde();
  const tabs = snap.previewTabs;
  const active = tabs.find((t) => t.id === snap.activePreviewId) ?? null;

  return (
    <div className="flex h-full flex-col bg-sidebar">
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

      {active && <PreviewToolbar tab={active} />}

      <div className="relative min-h-0 flex-1 overflow-hidden bg-white dark:bg-[#1e1e1e]">
        {tabs.map((t) => (
          <PreviewFrame
            key={t.id}
            tab={t}
            active={t.id === snap.activePreviewId}
            src={c.previewSrc(t)}
            setFrame={(id, el) => c.setPreviewFrame(id, el)}
            onLoad={(id) => c.onPreviewFrameLoad(id)}
          />
        ))}
        {active && active.port == null && (
          <div className="absolute inset-0 flex items-center justify-center bg-sidebar text-sm text-muted-foreground">
            Empty tab — type a local port (e.g. 3000) and press Enter.
          </div>
        )}
        {tabs.length === 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-sidebar text-sm text-muted-foreground">
            <span>No preview open.</span>
            <button
              onClick={() => c.addPreviewTab()}
              className="flex items-center gap-1.5 rounded border px-2 py-1 text-xs hover:bg-accent hover:text-foreground"
            >
              <PlusIcon className="size-3.5" /> New browser tab
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
