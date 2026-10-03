import { useEffect } from "react";
import { startTourOnFirstVisit } from "@/lib/tour";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { ActivityBar } from "../ActivityBar";
import { CommandPalette } from "../CommandPalette";
import { useIde } from "../controller/useIde";
import { EditorGroup } from "../EditorGroup";
import { Explorer } from "../Explorer";
import { PreviewPanel } from "../PreviewPanel";
import { StatusBar } from "../StatusBar";
import { TerminalPanel } from "../TerminalPanel";
import { TitleBar } from "../TitleBar";
import {
  CENTER_DEFAULT_SIZE,
  CENTER_MIN_SIZE,
  EDITOR_DEFAULT_SIZE,
  EDITOR_MIN_SIZE,
  EXPLORER_DEFAULT_SIZE,
  EXPLORER_MAX_SIZE,
  EXPLORER_MIN_SIZE,
  PREVIEW_DEFAULT_SIZE,
  TERMINAL_PANEL_DEFAULT_SIZE,
  TERMINAL_PANEL_MIN_SIZE,
} from "./constants";

export interface IShellChrome {
  titleBar?: boolean;
  activityBar?: boolean;
  statusBar?: boolean;
  /** The first-visit guided tour (off when embedded). */
  tour?: boolean;
  /** The editor + terminal column (off for a preview-only embed). */
  center?: boolean;
}

/** `chrome` hides parts of the frame (the embedded editor does); everything defaults to shown. */
export function AppShell({ chrome = {} }: { chrome?: IShellChrome }) {
  const { c, snap } = useIde();
  const { titleBar = true, activityBar = true, statusBar = true, tour = true, center = true } = chrome;

  // The tour for a first-time visitor, once the panels have laid out. A phone is too narrow for it:
  // the "Tour" button in the top bar is still there if someone wants it.
  useEffect(() => (!tour || window.innerWidth < 768 ? undefined : startTourOnFirstVisit("editor", 2200)), [tour]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // ⇧⌥F (VS Code's Format Document) from anywhere in the IDE. Monaco already handles it
      // while the editor has focus - and marks the event handled - so this only fills the gap
      // when focus is elsewhere (explorer, terminal header...). `e.code`, since ⌥ rewrites `e.key`
      // on macOS ("Ï").
      if (e.shiftKey && e.altKey && !e.metaKey && !e.ctrlKey && e.code === "KeyF") {
        if (e.defaultPrevented) return;
        e.preventDefault();
        void c.formatActiveDocument();
        return;
      }
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      // Alt+⌘B (macOS) / Alt+Ctrl+B — matched first since it also satisfies the plain
      // mod+B check below.
      if (e.altKey && (key === "b" || e.code === "KeyB")) {
        e.preventDefault();
        c.togglePreview();
      } else if (key === "b") {
        e.preventDefault();
        c.toggleSidebar();
      } else if (key === "j") {
        e.preventDefault();
        c.togglePanel();
      } else if (key === "s") {
        e.preventDefault();
        c.saveActiveFile();
      } else if (e.shiftKey && key === "p") {
        e.preventDefault();
        c.openPalette("command");
      } else if (key === "p") {
        e.preventDefault();
        c.openPalette("file");
      } else if (e.shiftKey && key === "c") {
        e.preventDefault();
        void c.newShellTerminal();
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [c]);

  // Browsers reserve ⌘W, so an editor tab can't be closed that way — warn instead before the
  // whole session (unsaved edits + any running dev server) is torn down.
  useEffect(() => {
    if (snap.dirty.length === 0) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    addEventListener("beforeunload", onBeforeUnload);
    return () => removeEventListener("beforeunload", onBeforeUnload);
  }, [snap.dirty.length]);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden text-foreground">
      {titleBar && <TitleBar />}
      <div className="flex min-h-0 flex-1">
        {activityBar && <ActivityBar />}
        <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
          {!snap.sidebarCollapsed && (
            <>
              <ResizablePanel id="explorer" defaultSize={EXPLORER_DEFAULT_SIZE} minSize={EXPLORER_MIN_SIZE} maxSize={EXPLORER_MAX_SIZE}>
                <Explorer key={snap.rootPath} />
              </ResizablePanel>
              <ResizableHandle />
            </>
          )}
          {center && (
            <>
              <ResizablePanel id="center" defaultSize={CENTER_DEFAULT_SIZE} minSize={CENTER_MIN_SIZE}>
                <ResizablePanelGroup orientation="vertical">
                  <ResizablePanel id="editor" defaultSize={EDITOR_DEFAULT_SIZE} minSize={EDITOR_MIN_SIZE}>
                    <EditorGroup />
                  </ResizablePanel>
                  {!snap.panelCollapsed && (
                    <>
                      <ResizableHandle />
                      <ResizablePanel id="terminal" defaultSize={TERMINAL_PANEL_DEFAULT_SIZE} minSize={TERMINAL_PANEL_MIN_SIZE}>
                        <TerminalPanel />
                      </ResizablePanel>
                    </>
                  )}
                </ResizablePanelGroup>
              </ResizablePanel>
            </>
          )}
          {!snap.previewCollapsed && (
            <>
              {center && <ResizableHandle />}
              <ResizablePanel id="preview" defaultSize={PREVIEW_DEFAULT_SIZE}>
                <PreviewPanel />
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
      </div>
      {statusBar && <StatusBar />}
      <CommandPalette />
    </div>
  );
}
