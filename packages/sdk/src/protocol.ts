/** The wire protocol between a host page (the SDK, `index.ts`) and the Studio `/embed` route.
 *  Every message carries `channel` so unrelated postMessage traffic on either side is ignored. */
export const EMBED_CHANNEL = "wcvm-embed";

export type EmbedView = "both" | "editor" | "preview";

/** Which parts of the IDE chrome to show. Anything omitted keeps the default for the chosen view. */
export interface IEmbedPanes {
  titleBar?: boolean;
  activityBar?: boolean;
  statusBar?: boolean;
  explorer?: boolean;
  terminal?: boolean;
}

export type EmbedFiles = Record<string, string>;

export interface IEmbedProject {
  /** Paths relative to the project root (`src/index.js`), mapped to their text contents. */
  files: EmbedFiles;
  /** Shown in the title bar. */
  title?: string;
  /** A file to open once the project loads. Defaults to the first file. */
  openFile?: string;
  /** Run once the files are written (e.g. `npm run dev`). `npm install` happens on its own when
   *  there is a package.json but no node_modules. */
  startCommand?: string;
}

export interface IEmbedConfig {
  view?: EmbedView;
  panes?: IEmbedPanes;
  theme?: "light" | "dark";
}

/** Requests the host sends to the editor; each is answered by a `response` with the same `id`. */
export type EmbedRequest =
  | { method: "openProject"; params: { project: IEmbedProject; config?: IEmbedConfig } }
  | { method: "readFile"; params: { path: string } }
  | { method: "writeFile"; params: { path: string; contents: string } }
  | { method: "readdir"; params: { path: string } }
  | { method: "remove"; params: { path: string } }
  | { method: "openFile"; params: { path: string } }
  | { method: "run"; params: { command: string } }
  | { method: "configure"; params: IEmbedConfig };

export type EmbedMethod = EmbedRequest["method"];

export interface IRunResult {
  exitCode: number;
  output: string;
}

export type EmbedEvent =
  | { event: "projectReady"; data: Record<string, never> }
  | { event: "fileSaved"; data: { path: string } }
  | { event: "previewReady"; data: { port: number; url: string } };

export type EmbedEventName = EmbedEvent["event"];

/** iframe -> host */
export type EmbedOutgoing =
  | { channel: typeof EMBED_CHANNEL; type: "ready" }
  | { channel: typeof EMBED_CHANNEL; type: "response"; id: number; ok: true; result: unknown }
  | { channel: typeof EMBED_CHANNEL; type: "response"; id: number; ok: false; error: string }
  | ({ channel: typeof EMBED_CHANNEL; type: "event" } & EmbedEvent);

/** host -> iframe */
export type EmbedIncoming = { channel: typeof EMBED_CHANNEL; type: "request"; id: number } & EmbedRequest;
