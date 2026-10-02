import { useEffect, useRef, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { basename } from "../controller/fs.service";
import { useIde } from "../controller/useIde";
import { Breadcrumb } from "./Breadcrumb";
import { ImageView } from "./ImageView";
import { MarkdownView } from "./MarkdownView";
import { TabStrip } from "./TabStrip";

export function EditorGroup() {
  const { c, snap } = useIde();
  const hostRef = useRef<HTMLDivElement | null>(null);

  // A queue of tabs still to close, plus the one currently prompting to save. A bulk close
  // feeds the queue; a clean tab closes immediately, a dirty one pops the dialog below.
  const [queue, setQueue] = useState<string[]>([]);
  const [promptPath, setPromptPath] = useState<string | null>(null);
  const [mdPreview, setMdPreview] = useState<string[]>([]);

  useEffect(() => {
    const el = hostRef.current;
    if (el) void c.mountEditor(el);
  }, [c]);

  const processQueue = (paths: string[]) => {
    let rest = paths;
    while (rest.length) {
      const path = rest[0];
      if (snap.dirty.includes(path)) {
        setQueue(rest.slice(1));
        setPromptPath(path);
        return;
      }
      c.closeTab(path);
      rest = rest.slice(1);
    }
    setQueue([]);
    setPromptPath(null);
  };

  const activeKind = snap.activeTab ? snap.tabKinds[snap.activeTab] : undefined;

  return (
    <div className="flex h-full flex-col bg-white dark:bg-[#1e1e1e]" data-tour="editor">
      <TabStrip onRequestClose={(path) => processQueue([path])} />

      {snap.activeTab && (
        <Breadcrumb path={snap.activeTab} rootPath={snap.rootPath} projectTitle={snap.projectTitle}
          markdownOpen={mdPreview.includes(snap.activeTab)}
          onToggleMarkdown={() =>
            setMdPreview((open) =>
              open.includes(snap.activeTab!) ? open.filter((p) => p !== snap.activeTab) : [...open, snap.activeTab!],
            )
          }
        />
      )}

      <div className="relative flex-1">
        <div ref={hostRef} className={cn("ide-editor-host absolute inset-0", activeKind !== "text" && "invisible")} />
        {activeKind === "image" && snap.activeTab && <ImageView key={snap.activeTab} path={snap.activeTab} />}
        {snap.activeTab && activeKind === "text" && mdPreview.includes(snap.activeTab) && (
          <MarkdownView key={snap.activeTab} path={snap.activeTab} />
        )}
        {!snap.activeTab && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
            Open a file from the Explorer
          </div>
        )}
      </div>

      <AlertDialog
        open={promptPath != null}
        onOpenChange={(open) => {
          if (open) return;
          setPromptPath(null);
          setQueue([]);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Do you want to save the changes you made to {promptPath ? basename(promptPath) : ""}?
            </AlertDialogTitle>
            <AlertDialogDescription>Your changes will be lost if you don&apos;t save them.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => {
                setPromptPath(null);
                setQueue([]);
              }}
            >
              Cancel
            </AlertDialogCancel>
            <Button
              variant="secondary"
              onClick={() => {
                if (promptPath) {
                  c.discardFile(promptPath);
                  c.closeTab(promptPath);
                }
                setPromptPath(null);
                processQueue(queue);
              }}
            >
              Don&apos;t Save
            </Button>
            <AlertDialogAction
              onClick={() => {
                if (promptPath) {
                  void c.saveFile(promptPath).then(() => c.closeTab(promptPath));
                }
                setPromptPath(null);
                processQueue(queue);
              }}
            >
              Save
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
