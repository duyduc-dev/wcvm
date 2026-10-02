import { PlusIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { useIde } from "../controller/useIde";
import { DevtoolsPane } from "./DevtoolsPane";
import { PreviewFrame } from "./PreviewFrame";
import { PreviewTabStrip } from "./PreviewTabStrip";
import { PreviewToolbar } from "./PreviewToolbar";

export function PreviewPanel() {
  const { c, snap } = useIde();
  const tabs = snap.previewTabs;
  const [devtoolsOpen, setDevtoolsOpen] = useState(false);
  const active = tabs.find((t) => t.id === snap.activePreviewId) ?? null;

  return (
    <div className="flex h-full flex-col bg-sidebar" data-tour="preview">
      <PreviewTabStrip />

      {active && <PreviewToolbar tab={active} devtoolsOpen={devtoolsOpen} onToggleDevtools={() => setDevtoolsOpen((o) => !o)} />}

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

      {devtoolsOpen && active && (
        <DevtoolsPane key={active.id} tabId={active.id} onClose={() => setDevtoolsOpen(false)} />
      )}
    </div>
  );
}
