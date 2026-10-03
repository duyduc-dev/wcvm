import { useCallback, useEffect, useRef, useState } from "react";
import type { IWcvm } from "wcvm";
import {
  EMBED_CHANNEL,
  type EmbedEvent,
  type EmbedIncoming,
  type EmbedOutgoing,
  type IEmbedConfig,
  type IEmbedProject,
} from "@wcvm/sdk/protocol";
import { applyTheme } from "@/lib/theme";
import { bootWcvm, getWcvmInstance } from "@/lib/wcvm";
import { AppShell } from "@/features/Editor/ide/AppShell";
import { IdeProvider } from "@/features/Editor/ide/controller/IdeProvider";
import { useIde } from "@/features/Editor/ide/controller/useIde";
import type { IdeController } from "@/features/Editor/ide/controller/IdeController";
import {
  EMBED_PROJECT_ROOT,
  parseConfigFromSearch,
  readProjectFile,
  resolveLayout,
  resolveProjectPath,
  runCommand,
  writeProject,
  type IResolvedLayout,
} from "./service";

interface ILoaded {
  /** Bumped per openProject so the IDE remounts on a fresh controller. */
  revision: number;
  title: string;
  openFile?: string;
  startCommand?: string;
}

/** Layout + theme + the host-facing controller handle, applied from inside the IDE's provider. */
function ControllerBridge({
  layout,
  isDark,
  loaded,
  controllerRef,
  emit,
}: {
  layout: IResolvedLayout;
  isDark: boolean | undefined;
  loaded: ILoaded;
  controllerRef: React.RefObject<IdeController | null>;
  emit: (e: EmbedEvent) => void;
}) {
  const { c, snap } = useIde();

  useEffect(() => {
    controllerRef.current = c;
    c.setStartCommand(loaded.startCommand ?? null);
    return () => {
      if (controllerRef.current === c) controllerRef.current = null;
    };
  }, [c, controllerRef, loaded.startCommand]);

  useEffect(() => {
    c.toggleSidebar(!layout.explorer);
    c.togglePanel(!layout.terminal);
    c.togglePreview(!layout.preview);
  }, [c, layout]);

  useEffect(() => {
    if (isDark !== undefined && isDark !== snap.isDark) c.toggleTheme();
  }, [c, isDark, snap.isDark]);

  useEffect(() => {
    const first = loaded.openFile ?? undefined;
    if (first) void c.openFile(resolveProjectPath(first));
  }, [c, loaded.openFile]);

  useEffect(() => {
    emit({ event: "projectReady", data: {} });
  }, [emit]);

  const saved = useRef(new Set<string>(snap.dirty));
  useEffect(() => {
    // A path leaving `dirty` was saved (or its tab closed - close prompts discard, so it's rare).
    for (const path of saved.current) {
      if (!snap.dirty.includes(path)) emit({ event: "fileSaved", data: { path: path.slice(EMBED_PROJECT_ROOT.length + 1) } });
    }
    saved.current = new Set(snap.dirty);
  }, [snap.dirty, emit]);

  const lastPreview = useRef<string | null>(null);
  useEffect(() => {
    const tab = snap.previewTabs.find((t) => t.id === snap.activePreviewId);
    if (tab?.port != null && lastPreview.current !== `${tab.port}`) {
      lastPreview.current = `${tab.port}`;
      emit({ event: "previewReady", data: { port: tab.port, url: c.previewSrc(tab) } });
    }
  }, [snap.previewTabs, snap.activePreviewId, c, emit]);

  return null;
}

export default function Embed() {
  const parent = window.parent;
  const [loaded, setLoaded] = useState<ILoaded | null>(null);
  const [config, setConfig] = useState<IEmbedConfig>(() => parseConfigFromSearch(new URLSearchParams(location.search)));
  const controllerRef = useRef<IdeController | null>(null);
  const hostOrigin = useRef<string | null>(null);

  const post = useCallback(
    (msg: EmbedOutgoing) => {
      // Until the host's first request tells us who it is, only `ready` is ever sent - and that one
      // carries nothing, so "*" is safe there. Everything else goes to the learned origin only.
      parent.postMessage(msg, msg.type === "ready" ? "*" : (hostOrigin.current ?? "*"));
    },
    [parent],
  );

  const emit = useCallback((e: EmbedEvent) => post({ channel: EMBED_CHANNEL, type: "event", ...e }), [post]);

  useEffect(() => {
    if (parent === window) return;
    let alive = true;
    let wc: IWcvm;

    const handle = async (msg: EmbedIncoming): Promise<unknown> => {
      switch (msg.method) {
        case "openProject": {
          const { project, config: next } = msg.params as { project: IEmbedProject; config?: IEmbedConfig };
          await writeProject(wc, project.files);
          if (next) setConfig((prev) => ({ ...prev, ...stripUndefined(next) }));
          setLoaded((prev) => ({
            revision: (prev?.revision ?? 0) + 1,
            title: project.title ?? "project",
            openFile: project.openFile ?? Object.keys(project.files)[0],
            startCommand: project.startCommand,
          }));
          return null;
        }
        case "readFile":
          return readProjectFile(wc, msg.params.path);
        case "writeFile":
          await wc.fs.writeFile(resolveProjectPath(msg.params.path), msg.params.contents);
          return null;
        case "readdir":
          return wc.fs.readdir(resolveProjectPath(msg.params.path));
        case "remove":
          await wc.fs.rm(resolveProjectPath(msg.params.path), { recursive: true });
          return null;
        case "openFile": {
          const c = controllerRef.current;
          if (!c) throw new Error("No project is open yet");
          await c.openFile(resolveProjectPath(msg.params.path));
          return null;
        }
        case "run":
          return runCommand(wc, msg.params.command);
        case "configure":
          setConfig((prev) => ({ ...prev, ...stripUndefined(msg.params) }));
          return null;
      }
    };

    const onMessage = (e: MessageEvent<EmbedIncoming>) => {
      const msg = e.data;
      if (e.source !== parent || !msg || msg.channel !== EMBED_CHANNEL || msg.type !== "request") return;
      hostOrigin.current ??= e.origin;
      if (e.origin !== hostOrigin.current) return;
      handle(msg).then(
        (result) => post({ channel: EMBED_CHANNEL, type: "response", id: msg.id, ok: true, result }),
        (error: unknown) =>
          post({
            channel: EMBED_CHANNEL,
            type: "response",
            id: msg.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
      );
    };

    addEventListener("message", onMessage);
    void bootWcvm().then(() => {
      if (!alive) return;
      wc = getWcvmInstance();
      post({ channel: EMBED_CHANNEL, type: "ready" });
    });
    return () => {
      alive = false;
      removeEventListener("message", onMessage);
    };
  }, [parent, post]);

  useEffect(() => {
    if (config.theme) applyTheme(config.theme === "dark");
  }, [config.theme]);

  if (parent === window) {
    return <div className="p-4 text-sm text-muted-foreground">This page is meant to be embedded in an iframe. See the @wcvm/sdk package.</div>;
  }
  if (!loaded) {
    return <div className="flex h-screen w-screen items-center justify-center text-sm text-muted-foreground">Starting…</div>;
  }

  const layout = resolveLayout(config.view, config.panes);
  return (
    <div className="h-screen w-screen overflow-hidden">
      <IdeProvider key={loaded.revision} rootPath={EMBED_PROJECT_ROOT} projectId="embed">
        <ControllerBridge
          layout={layout}
          isDark={config.theme ? config.theme === "dark" : undefined}
          loaded={loaded}
          controllerRef={controllerRef}
          emit={emit}
        />
        <AppShell chrome={{ ...layout, center: layout.editor, tour: false }} />
      </IdeProvider>
    </div>
  );
}

const stripUndefined = <T extends object>(obj: T): Partial<T> =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
