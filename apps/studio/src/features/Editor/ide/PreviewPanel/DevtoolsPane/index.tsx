import { XIcon } from "@phosphor-icons/react";
import { useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { ConsolePane } from "./ConsolePane";
import { ElementsPane } from "./ElementsPane";
import { getFrameConsole } from "./service/frameConsole";

type DevtoolsTab = "console" | "elements";

const MIN_HEIGHT = 120;

/** A browser-DevTools-style pane docked under a preview frame: a Console (captured logs/errors +
 * an expression prompt) and an Elements inspector (live DOM tree, element picker, attribute
 * editing), both reading the same-origin preview iframe directly. */
export function DevtoolsPane({ tabId, onClose }: { tabId: string; onClose: () => void }) {
  const [tab, setTab] = useState<DevtoolsTab>("console");
  const [height, setHeight] = useState(260);
  const container = useRef<HTMLDivElement | null>(null);
  const store = getFrameConsole(tabId);

  // Pointer capture keeps move events coming to the handle even while the cursor is over the
  // preview iframe, which would otherwise swallow them (window listeners go dead mid-drag).
  const drag = useRef<{ startY: number; startHeight: number; max: number } | null>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = {
      startY: e.clientY,
      startHeight: container.current?.offsetHeight ?? height,
      max: (container.current?.parentElement?.clientHeight ?? 600) - 80,
    };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (!d) return;
    setHeight(Math.min(d.max, Math.max(MIN_HEIGHT, d.startHeight + d.startY - e.clientY)));
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  return (
    <div ref={container} style={{ height }} className="flex shrink-0 flex-col border-t bg-sidebar">
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className="relative z-10 h-1 shrink-0 cursor-row-resize touch-none select-none bg-border hover:bg-primary/40 active:bg-primary/60 before:absolute before:inset-x-0 before:-top-1 before:h-3 before:content-['']"
      />
      <div className="flex h-7 shrink-0 items-stretch border-b bg-[#f3f3f3] dark:bg-[#181818]">
        {(["console", "elements"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              "px-3 text-xs capitalize",
              tab === t ? "border-b-2 border-primary text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t}
          </button>
        ))}
        <div className="flex-1" />
        <button
          title="Close DevTools"
          aria-label="Close DevTools"
          onClick={onClose}
          className="flex w-7 items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <XIcon className="size-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1">
        {tab === "console" ? <ConsolePane store={store} /> : <ElementsPane store={store} />}
      </div>
    </div>
  );
}
