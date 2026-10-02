import { CaretDownIcon, PlusIcon } from "@phosphor-icons/react";
import { useEffect, useRef } from "react";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { cn } from "@/lib/utils";
import { useIde } from "../controller/useIde";
import {
  TERMINAL_CONTENT_DEFAULT_SIZE,
  TERMINAL_CONTENT_MIN_SIZE,
  TERMINAL_LIST_DEFAULT_SIZE,
  TERMINAL_LIST_MAX_SIZE,
  TERMINAL_LIST_MIN_SIZE,
} from "./constants";
import { TerminalList } from "./TerminalList";

export function TerminalPanel() {
  const { c, snap } = useIde();
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const activeTermId = snap.activeTermId;
  const activeTask = snap.terminals.find((t) => t.id === activeTermId)?.task;

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => c.fitTerminal(activeTermId));
    observer.observe(el);
    return () => observer.disconnect();
  }, [c, activeTermId]);

  useEffect(() => {
    c.fitTerminal(activeTermId);
  }, [c, activeTermId]);

  return (
    <div className="flex h-full flex-col bg-white dark:bg-[#181818]">
      <div className="flex h-8 shrink-0 items-center border-b pr-2">
        <span className="px-3 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          Terminal
        </span>
        <span className="flex-1 truncate text-[11px] text-muted-foreground" role="status">
          {activeTask ? `${activeTask}…` : ""}
        </span>
        <button
          title="New Terminal"
          className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => void c.newShellTerminal()}
        >
          <PlusIcon className="size-4" />
        </button>
        <button
          title="Hide panel"
          className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => c.togglePanel(true)}
        >
          <CaretDownIcon className="size-4" />
        </button>
      </div>

      {activeTask && (
        <div className="relative h-0.5 shrink-0 overflow-hidden bg-primary/15" role="progressbar" aria-label={activeTask}>
          <div className="ide-indeterminate absolute inset-y-0 left-0 w-1/4 bg-primary" />
        </div>
      )}
      <div ref={bodyRef} className="relative flex-1 overflow-hidden">
        <ResizablePanelGroup orientation="horizontal">
          <ResizablePanel
            id="term-content"
            defaultSize={TERMINAL_CONTENT_DEFAULT_SIZE}
            minSize={TERMINAL_CONTENT_MIN_SIZE}
            onResize={() => c.fitTerminal(activeTermId)}
          >
            <div className="relative h-full min-w-0">
              {snap.terminals.length === 0 && (
                <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
                  No terminals. Press <span className="mx-1 text-foreground">+</span> to create one.
                </div>
              )}
              {snap.terminals.map((t) => (
                <div
                  key={t.id}
                  className={cn("ide-term-host absolute inset-0", t.id === activeTermId ? "block" : "hidden")}
                  ref={(el) => c.mountTerminal(t.id, el)}
                />
              ))}
            </div>
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel
            id="term-list"
            defaultSize={TERMINAL_LIST_DEFAULT_SIZE}
            minSize={TERMINAL_LIST_MIN_SIZE}
            maxSize={TERMINAL_LIST_MAX_SIZE}
          >
            <TerminalList terminals={snap.terminals} />
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  );
}
