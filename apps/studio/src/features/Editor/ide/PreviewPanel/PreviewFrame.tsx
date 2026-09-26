import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import type { PreviewTab } from "../controller/types";
import { PREVIEW_IFRAME_SANDBOX } from "./constants";

interface PreviewFrameProps {
  tab: PreviewTab;
  active: boolean;
  src: string;
  setFrame: (id: string, el: HTMLIFrameElement | null) => void;
  onLoad: (id: string) => void;
}

/** Starts at `about:blank` and only navigates once mounted, imperatively — a brand-new iframe's
 * first, direct navigation can slip past the preview Service Worker before it's controlling the
 * page (see `wc.preview.enable()`'s own doc comment); navigating from an already-live document is
 * reliably intercepted. */
export function PreviewFrame({ tab, active, src, setFrame, onLoad }: PreviewFrameProps) {
  const ref = useRef<HTMLIFrameElement | null>(null);
  const lastSrc = useRef<string | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || lastSrc.current === src) return;
    lastSrc.current = src;
    el.src = src;
  }, [src]);

  return (
    <iframe
      ref={(el) => {
        ref.current = el;
        setFrame(tab.id, el);
      }}
      onLoad={() => onLoad(tab.id)}
      title={tab.title ?? (tab.port != null ? `Preview (${tab.port})` : "New Tab")}
      className={cn("absolute inset-0 h-full w-full border-0", active ? "block" : "hidden")}
      sandbox={PREVIEW_IFRAME_SANDBOX}
    />
  );
}
