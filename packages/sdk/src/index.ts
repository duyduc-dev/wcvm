import {
  EMBED_CHANNEL,
  type EmbedEvent,
  type EmbedEventName,
  type EmbedOutgoing,
  type EmbedRequest,
  type IEmbedConfig,
  type IEmbedProject,
  type IRunResult,
} from "./protocol";

export type { EmbedView, IEmbedConfig, IEmbedPanes, IEmbedProject, IRunResult } from "./protocol";

export const DEFAULT_EMBED_URL = "https://studio.wcvmjs.com/embed";

export interface IEmbedOptions extends IEmbedConfig {
  /** Where the editor is hosted. Defaults to the public Studio. */
  url?: string;
  /** Iframe width (CSS length or px number). Defaults to filling the container. */
  width?: string | number;
  /** Iframe height (CSS length or px number). Defaults to 600px. */
  height?: string | number;
  /** How long to wait for the editor to boot before rejecting, in ms. Defaults to 60s. */
  timeout?: number;
}

export interface IEmbedVm {
  readonly iframe: HTMLIFrameElement;
  fs: {
    readFile(path: string): Promise<string>;
    writeFile(path: string, contents: string): Promise<void>;
    readdir(path: string): Promise<string[]>;
    remove(path: string): Promise<void>;
  };
  openFile(path: string): Promise<void>;
  /** Runs a shell command in the project and resolves when it exits. Don't use it for dev servers
   *  (it never exits) - put those in the project's `startCommand`. */
  run(command: string): Promise<IRunResult>;
  configure(config: IEmbedConfig): Promise<void>;
  on<K extends EmbedEventName>(
    event: K,
    listener: (data: Extract<EmbedEvent, { event: K }>["data"]) => void,
  ): () => void;
  destroy(): void;
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

/** Mounts the editor in `target` and loads `project` into it. */
export async function embed(
  target: HTMLElement | string,
  project: IEmbedProject,
  options: IEmbedOptions = {},
): Promise<IEmbedVm> {
  const host = typeof target === "string" ? document.querySelector<HTMLElement>(target) : target;
  if (!host) throw new Error(`@wcvm/sdk: no element matches ${String(target)}`);

  const src = new URL(options.url ?? DEFAULT_EMBED_URL);
  const iframe = document.createElement("iframe");
  iframe.src = src.href;
  iframe.title = project.title ?? "wcvm editor";
  // cross-origin-isolated: wcvm needs SharedArrayBuffer. It only takes effect when this page is
  // itself cross-origin isolated (COOP same-origin + COEP require-corp) - see the package README.
  iframe.allow = "cross-origin-isolated; clipboard-read; clipboard-write";
  const cssLength = (value: string | number | undefined, fallback: string) =>
    typeof value === "number" ? `${value}px` : (value ?? fallback);
  iframe.style.cssText = `border:0;max-width:100%;width:${cssLength(options.width, "100%")};height:${cssLength(options.height, "600px")}`;
  host.replaceChildren(iframe);

  const pending = new Map<number, Pending>();
  const listeners = new Map<string, Set<(data: never) => void>>();
  let nextId = 1;
  let destroyed = false;

  let onReady!: () => void;
  const ready = new Promise<void>((resolve) => (onReady = resolve));

  const onMessage = (e: MessageEvent<EmbedOutgoing>) => {
    if (e.source !== iframe.contentWindow || e.origin !== src.origin) return;
    const msg = e.data;
    if (!msg || msg.channel !== EMBED_CHANNEL) return;
    if (msg.type === "ready") onReady();
    else if (msg.type === "response") {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error));
    } else if (msg.type === "event") {
      for (const l of listeners.get(msg.event) ?? []) (l as (d: unknown) => void)(msg.data);
    }
  };
  window.addEventListener("message", onMessage);

  const destroy = () => {
    destroyed = true;
    window.removeEventListener("message", onMessage);
    for (const p of pending.values()) p.reject(new Error("@wcvm/sdk: destroyed"));
    pending.clear();
    iframe.remove();
  };

  const request = <T>(req: EmbedRequest): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (destroyed) return reject(new Error("@wcvm/sdk: destroyed"));
      const id = nextId++;
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      iframe.contentWindow?.postMessage({ channel: EMBED_CHANNEL, type: "request", id, ...req }, src.origin);
    });

  const timeout = options.timeout ?? 60_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      ready,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("@wcvm/sdk: the editor did not respond - is the page cross-origin isolated?")),
          timeout,
        );
      }),
    ]);
  } catch (error) {
    destroy();
    throw error;
  } finally {
    clearTimeout(timer);
  }

  const vm: IEmbedVm = {
    iframe,
    fs: {
      readFile: (path) => request({ method: "readFile", params: { path } }),
      writeFile: (path, contents) => request({ method: "writeFile", params: { path, contents } }),
      readdir: (path) => request({ method: "readdir", params: { path } }),
      remove: (path) => request({ method: "remove", params: { path } }),
    },
    openFile: (path) => request({ method: "openFile", params: { path } }),
    run: (command) => request<IRunResult>({ method: "run", params: { command } }),
    configure: (config) => request({ method: "configure", params: config }),
    on(event, listener) {
      const set = listeners.get(event) ?? new Set();
      set.add(listener as (data: never) => void);
      listeners.set(event, set);
      return () => set.delete(listener as (data: never) => void);
    },
    destroy,
  };

  const { view, panes, theme } = options;
  await request({ method: "openProject", params: { project, config: { view, panes, theme } } });
  return vm;
}
