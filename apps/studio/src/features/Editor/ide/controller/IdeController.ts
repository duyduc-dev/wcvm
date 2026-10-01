import type * as Monaco from "monaco-editor";
import { v6 as uuidv6 } from "uuid";
import type { IProcess, IWcvm } from "wcvm";
import {
  createEditor,
  disposeModel,
  ensureMonaco,
  getOrCreateModel,
  renameModel,
} from "./editor.service";
import { EditorStatus } from "./editorStatus";
import { basename, mimeTypeFor, readTextFile, tabKindFor, writeTextFile } from "./fs.service";
import { STATUS_MESSAGE_TIMEOUT_MS } from "./constants";
import { applyTheme, getInitialIsDark } from "@/lib/theme";
import { useWcvmProjectStore } from "@/stores/useWcvmProjectStore";
import {
  createEmptyPreviewTab,
  createPreviewTab,
  parseAddress,
  previewSrc,
} from "./preview.service";
import {
  createShellTerminal,
  shellTerminalLabel,
  updateTerminalTheme,
  type TerminalHandle,
} from "./terminal.service";
import type { IdeSnapshot, PaletteMode, PreviewTab } from "./types";

export class IdeController {
  readonly editorStatus = new EditorStatus();

  private listeners = new Set<() => void>();
  private snap: IdeSnapshot;

  private monaco: typeof Monaco | null = null;
  private editor: Monaco.editor.IStandaloneCodeEditor | null = null;
  private models = new Map<string, Monaco.editor.ITextModel>();
  private savedContents = new Map<string, string>();
  private imageUrls = new Map<string, string>();

  private terminals = new Map<string, TerminalHandle>();
  private terminalHosts = new Map<string, HTMLElement>();
  private terminalCount = 0;

  private previewFrames = new Map<string, HTMLIFrameElement>();
  private stopPreviewListener: (() => void) | null = null;

  private statusTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly wc: IWcvm;
  private readonly projectId: string;

  constructor(wc: IWcvm, rootPath: string, projectId: string) {
    this.wc = wc;
    this.projectId = projectId;
    this.snap = {
      rootPath,
      projectTitle: basename(rootPath),
      isDark: getInitialIsDark(),
      sidebarCollapsed: false,
      panelCollapsed: false,
      previewCollapsed: false,
      openTabs: [],
      activeTab: null,
      previewTab: null,
      dirty: [],
      tabKinds: {},
      terminals: [],
      activeTermId: null,
      previewTabs: [],
      activePreviewId: null,
      paletteOpen: false,
      paletteMode: "command",
      statusMessage: null,
    };
  }

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  getSnapshot = (): IdeSnapshot => this.snap;

  private set(partial: Partial<IdeSnapshot>): void {
    this.snap = { ...this.snap, ...partial };
    for (const cb of this.listeners) cb();
  }

  get fs() {
    return this.wc.fs;
  }

  start(): void {
    // Marks the project "opened" even if nothing ends up being edited this session - saveFile()
    // below bumps it again on an actual edit, so this is just a floor, not the only signal.
    useWcvmProjectStore.getState().touchProject(this.projectId);
    // The `.dark` class itself is already applied app-wide at boot (see __root.tsx) — nothing
    // theme-specific to do here.
    void this.wc.preview.enable();
    this.stopPreviewListener = this.wc.preview.onListen(({ port, listening }) => {
      if (!listening) return;
      const existing = this.snap.previewTabs.find((t) => t.port === port);
      if (existing) {
        // The port is listening AGAIN: the first listener was transient (Angular's `ng serve`
        // binds and releases its port once just to check it's free, before the real server
        // starts - the tab opened on that first bind and got ECONNREFUSED) or a dev server was
        // restarted. Reload so the tab reaches whoever is listening now.
        this.reloadPreviewTab(existing.id);
        return;
      }
      const tab = createPreviewTab(uuidv6(), port);
      this.set({
        previewTabs: [...this.snap.previewTabs, tab],
        activePreviewId: tab.id,
        previewCollapsed: false,
      });
    });
  }

  dispose(): void {
    this.stopPreviewListener?.();
    // Kill each terminal's own process, not just its UI - the wcvm instance itself is a singleton
    // that outlives this editor (see @/lib/wcvm), so leaving this page (Home, or back into a
    // different project) would otherwise leave every shell - and anything it spawned, like a
    // `npm run dev` typed into it - running invisibly in the background forever, still holding
    // its port (confirmed directly: a killed shell's own child_process is gone too, freeing the
    // port immediately - wcvm's own documented subtree-kill). Mirrors what closeTerminal() already
    // does for one terminal at a time, just for all of them at once on a full teardown.
    for (const handle of this.terminals.values()) {
      handle.process.kill();
      handle.dispose();
    }
    for (const model of this.models.values()) model.dispose();
    for (const url of this.imageUrls.values()) URL.revokeObjectURL(url);
    this.editor?.dispose();
    if (this.statusTimer) clearTimeout(this.statusTimer);
  }

  // ── layout ──────────────────────────────────────────────────────────────
  toggleSidebar(force?: boolean): void {
    this.set({ sidebarCollapsed: force ?? !this.snap.sidebarCollapsed });
  }

  togglePanel(force?: boolean): void {
    this.set({ panelCollapsed: force ?? !this.snap.panelCollapsed });
  }

  togglePreview(force?: boolean): void {
    this.set({ previewCollapsed: force ?? !this.snap.previewCollapsed });
  }

  toggleTheme(): void {
    const isDark = !this.snap.isDark;
    applyTheme(isDark);
    this.monaco?.editor.setTheme(isDark ? "vs-dark" : "vs");
    for (const handle of this.terminals.values()) updateTerminalTheme(handle.term, isDark);
    this.set({ isDark });
  }

  status(text: string): void {
    if (this.statusTimer) clearTimeout(this.statusTimer);
    this.set({ statusMessage: text });
    this.statusTimer = setTimeout(() => this.set({ statusMessage: null }), STATUS_MESSAGE_TIMEOUT_MS);
  }

  // ── editor / tabs ───────────────────────────────────────────────────────
  async mountEditor(el: HTMLElement): Promise<void> {
    if (this.editor) return;
    const monaco = await ensureMonaco();
    this.monaco = monaco;
    this.editor = createEditor(monaco, el, this.snap.isDark);
    this.editor.onDidChangeModelContent(() => {
      const path = this.snap.activeTab;
      if (path && this.snap.tabKinds[path] === "text") this.refreshDirty(path);
    });
    this.wireEditorStatus(this.editor);
    if (this.snap.activeTab) this.showInEditor(this.snap.activeTab);
  }

  /** Cursor position, selection and language mode, mirrored onto `editorStatus` — its own tiny
   * store, so StatusBar re-renders on a cursor move without every other IDE panel doing the
   * same (see EditorStatus's own doc comment). Re-bound on `onDidChangeModel` so switching tabs
   * (or clearing the model when the last tab closes) is picked up automatically. */
  private wireEditorStatus(editor: Monaco.editor.IStandaloneCodeEditor): void {
    const updateCursor = () => {
      const model = editor.getModel();
      const position = editor.getPosition();
      if (!model || !position) {
        this.editorStatus.set({ cursor: null });
        return;
      }
      const selections = editor.getSelections() ?? [];
      const selectedChars = selections.reduce((sum, sel) => sum + (model.getValueLengthInRange(sel) || 0), 0);
      this.editorStatus.set({
        cursor: { line: position.lineNumber, column: position.column, selectedChars, selectionCount: selections.length },
      });
    };
    const updateLanguage = () => {
      this.editorStatus.set({ language: editor.getModel()?.getLanguageId() ?? null });
    };
    editor.onDidChangeCursorPosition(updateCursor);
    editor.onDidChangeCursorSelection(updateCursor);
    editor.onDidChangeModel(() => {
      updateCursor();
      updateLanguage();
    });
  }

  private refreshDirty(path: string): void {
    const model = this.models.get(path);
    if (!model) return;
    const isDirty = model.getValue() !== (this.savedContents.get(path) ?? "");
    const already = this.snap.dirty.includes(path);
    if (isDirty === already) return;
    this.set({
      dirty: isDirty ? [...this.snap.dirty, path] : this.snap.dirty.filter((p) => p !== path),
    });
  }

  /** Reads a file/image's contents into the editor's own caches — called once, the first time a
   * path is opened as a tab. */
  private async loadTabContent(path: string, kind: ReturnType<typeof tabKindFor>): Promise<void> {
    if (kind === "image") {
      const bytes = await this.fs.readFile(path);
      const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mimeTypeFor(path) }));
      this.imageUrls.set(path, url);
    } else {
      this.savedContents.set(path, await readTextFile(this.fs, path));
    }
  }

  /** Releases everything a tab was holding onto (Monaco model, cached text, object URL) — used
   * both when a tab closes for good and when a preview tab gets replaced by the next one. */
  private disposeTabResources(path: string): void {
    disposeModel(this.models, path);
    this.savedContents.delete(path);
    const url = this.imageUrls.get(path);
    if (url) {
      URL.revokeObjectURL(url);
      this.imageUrls.delete(path);
    }
  }

  /** Points the (already-mounted) editor at `path`'s model, creating it on first use. A no-op
   * for an image tab or before the editor has mounted — `mountEditor` re-runs this once it has. */
  private showInEditor(path: string): void {
    if (!this.editor || !this.monaco || this.snap.tabKinds[path] !== "text") return;
    const model = getOrCreateModel(this.monaco, this.models, path, this.savedContents.get(path) ?? "");
    this.editor.setModel(model);
  }

  async openFile(path: string, opts: { preview?: boolean } = {}): Promise<void> {
    const preview = opts.preview ?? false;
    if (!this.snap.openTabs.includes(path)) {
      const kind = tabKindFor(path);
      await this.loadTabContent(path, kind);
      let openTabs = this.snap.openTabs;
      // A new preview-mode tab replaces the last one rather than piling up, matching VS Code's
      // quick-look behavior — but never one the user has since edited.
      const previousPreview = this.snap.previewTab;
      if (preview && previousPreview && previousPreview !== path && !this.snap.dirty.includes(previousPreview)) {
        this.disposeTabResources(previousPreview);
        openTabs = openTabs.filter((p) => p !== previousPreview);
      }
      this.set({
        openTabs: [...openTabs, path],
        tabKinds: { ...this.snap.tabKinds, [path]: kind },
        previewTab: preview ? path : previousPreview === path ? previousPreview : this.snap.previewTab,
      });
    }
    this.set({ activeTab: path });
    this.showInEditor(path);
  }

  pinTab(path: string): void {
    if (this.snap.previewTab === path) this.set({ previewTab: null });
  }

  closeTab(path: string): void {
    const openTabs = this.snap.openTabs.filter((p) => p !== path);
    const wasActive = this.snap.activeTab === path;
    const activeTab = wasActive ? (openTabs.at(-1) ?? null) : this.snap.activeTab;
    this.disposeTabResources(path);
    this.set({
      openTabs,
      activeTab,
      previewTab: this.snap.previewTab === path ? null : this.snap.previewTab,
      dirty: this.snap.dirty.filter((p) => p !== path),
    });
    if (wasActive) {
      if (activeTab) this.showInEditor(activeTab);
      else this.editor?.setModel(null);
    }
  }

  async saveFile(path: string): Promise<void> {
    const model = this.models.get(path);
    if (!model) return;
    const contents = model.getValue();
    await writeTextFile(this.fs, path, contents);
    this.savedContents.set(path, contents);
    this.set({ dirty: this.snap.dirty.filter((p) => p !== path) });
    this.status(`Saved ${basename(path)}`);
    useWcvmProjectStore.getState().touchProject(this.projectId);
  }

  saveActiveFile(): void {
    if (this.snap.activeTab) void this.saveFile(this.snap.activeTab);
  }

  discardFile(path: string): void {
    const model = this.models.get(path);
    const saved = this.savedContents.get(path);
    if (model && saved !== undefined) model.setValue(saved);
  }

  imageUrlFor(path: string): string | undefined {
    return this.imageUrls.get(path);
  }

  renamePath(from: string, to: string): void {
    if (!this.snap.openTabs.includes(from)) return;
    const wasActive = this.snap.activeTab === from;
    if (this.monaco) renameModel(this.monaco, this.models, from, to);
    const savedContents = this.savedContents.get(from);
    if (savedContents !== undefined) {
      this.savedContents.delete(from);
      this.savedContents.set(to, savedContents);
    }
    const imageUrl = this.imageUrls.get(from);
    if (imageUrl !== undefined) {
      this.imageUrls.delete(from);
      this.imageUrls.set(to, imageUrl);
    }
    const rename = (path: string) => (path === from ? to : path);
    this.set({
      openTabs: this.snap.openTabs.map(rename),
      activeTab: this.snap.activeTab ? rename(this.snap.activeTab) : null,
      previewTab: this.snap.previewTab ? rename(this.snap.previewTab) : null,
      dirty: this.snap.dirty.map(rename),
      tabKinds: Object.fromEntries(
        Object.entries(this.snap.tabKinds).map(([p, kind]) => [rename(p), kind]),
      ),
    });
    if (wasActive) this.editor?.setModel(this.models.get(to) ?? null);
  }

  // ── terminals ───────────────────────────────────────────────────────────
  async newShellTerminal(): Promise<void> {
    const id = uuidv6();
    this.terminalCount += 1;
    // FORCE_COLOR: this shell has no real TTY, so chalk/picocolors-based CLIs (npm, vite, ...)
    // detect that and disable their own colored output by default — forcing it back on is what
    // gets Vite's real, colorful startup banner (and anything else's) to actually show here.
    const process: IProcess = await this.wc.spawn("sh", [], {
      cwd: this.snap.rootPath,
      // JOBS=1: broccoli-babel-transpiler (Ember's build) otherwise starts a worker-process pool
      // that never answers in this sandbox and the build hangs forever; 1 makes it transpile inline.
      //
      // NG_BUILD_*: @angular/build - BABEL_LINKER routes Angular's partial-compilation linking through
      // Babel instead of its oxc-parser based linker (a native WASM parser that deadlocks here);
      // OPTIMIZE_CHUNKS=false skips the one production step that needs the native `rolldown`.
      env: { FORCE_COLOR: "3", JOBS: "1", NG_BUILD_BABEL_LINKER: "true", NG_BUILD_OPTIMIZE_CHUNKS: "false" },
    });
    const handle = createShellTerminal(process, this.snap.isDark, () => this.markTerminalDead(id));
    this.terminals.set(id, handle);
    const entry = { id, label: shellTerminalLabel(this.terminalCount), alive: true };
    this.set({
      terminals: [...this.snap.terminals, entry],
      activeTermId: id,
      panelCollapsed: false,
    });
  }

  private markTerminalDead(id: string): void {
    this.set({
      terminals: this.snap.terminals.map((t) => (t.id === id ? { ...t, alive: false } : t)),
    });
  }

  mountTerminal(id: string, el: HTMLElement | null): void {
    if (!el) return;
    const handle = this.terminals.get(id);
    if (!handle || this.terminalHosts.get(id) === el) return;
    this.terminalHosts.set(id, el);
    handle.term.open(el);
    // No fit() here: the host's flex/resizable-panel layout hasn't settled synchronously
    // during this ref callback yet, and fitting against a not-yet-final size corrupts xterm's
    // canvas (stale glyphs left behind once it re-measures correctly a moment later).
    // TerminalPanel's own effect + ResizeObserver call fitTerminal() once layout is real.
  }

  fitTerminal(id: string | null): void {
    if (!id) return;
    this.terminals.get(id)?.fit.fit();
  }

  switchTerminal(id: string): void {
    this.set({ activeTermId: id, panelCollapsed: false });
  }

  closeTerminal(id: string): void {
    this.terminals.get(id)?.process.kill();
    this.terminals.get(id)?.dispose();
    this.terminals.delete(id);
    this.terminalHosts.delete(id);
    const terminals = this.snap.terminals.filter((t) => t.id !== id);
    const activeTermId =
      this.snap.activeTermId === id ? (terminals.at(-1)?.id ?? null) : this.snap.activeTermId;
    this.set({ terminals, activeTermId });
  }

  clearActiveTerminal(): void {
    if (this.snap.activeTermId) this.terminals.get(this.snap.activeTermId)?.term.clear();
  }

  // ── preview ─────────────────────────────────────────────────────────────
  addPreviewTab(): void {
    const tab = createEmptyPreviewTab(uuidv6());
    this.set({
      previewTabs: [...this.snap.previewTabs, tab],
      activePreviewId: tab.id,
      previewCollapsed: false,
    });
  }

  activatePreviewTab(id: string): void {
    this.set({ activePreviewId: id });
  }

  private updatePreviewTab(id: string, patch: Partial<PreviewTab>): void {
    this.set({
      previewTabs: this.snap.previewTabs.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    });
  }

  closePreviewTab(id: string): void {
    this.previewFrames.delete(id);
    const previewTabs = this.snap.previewTabs.filter((t) => t.id !== id);
    const activePreviewId =
      this.snap.activePreviewId === id ? (previewTabs.at(-1)?.id ?? null) : this.snap.activePreviewId;
    this.set({ previewTabs, activePreviewId });
  }

  closeOtherPreviewTabs(id: string): void {
    for (const t of this.snap.previewTabs) if (t.id !== id) this.previewFrames.delete(t.id);
    this.set({ previewTabs: this.snap.previewTabs.filter((t) => t.id === id), activePreviewId: id });
  }

  closeAllPreviewTabs(): void {
    this.previewFrames.clear();
    this.set({ previewTabs: [], activePreviewId: null });
  }

  setPreviewUrl(id: string, raw: string): void {
    this.updatePreviewTab(id, { url: raw });
  }

  navigatePreview(id: string, raw: string): void {
    const parsed = parseAddress(raw);
    if (!parsed) {
      this.status("Only a local port (e.g. 3000, or 3000/api) can be previewed.");
      return;
    }
    this.updatePreviewTab(id, {
      port: parsed.port,
      path: parsed.path,
      url: `localhost:${parsed.port}${parsed.path}`,
    });
  }

  /** Unlike `navigatePreview` (which changes the iframe's own `src` and so always renavigates it
   *  - see `PreviewFrame`'s own effect), reloading the SAME url needs a real, explicit reload:
   *  the frame is same-origin (the preview Service Worker relay needs that), so this reaches
   *  into it directly, the same way `previewBack`/`previewForward` already do. */
  reloadPreviewTab(id: string): void {
    try {
      this.previewFrames.get(id)?.contentWindow?.location.reload();
    } catch {
      /* cross-origin — nothing to do */
    }
  }

  setPreviewFrame(id: string, el: HTMLIFrameElement | null): void {
    if (el) this.previewFrames.set(id, el);
    else this.previewFrames.delete(id);
  }

  previewBack(id: string): void {
    try {
      this.previewFrames.get(id)?.contentWindow?.history.back();
    } catch {
      /* cross-origin — nothing to do */
    }
  }

  previewForward(id: string): void {
    try {
      this.previewFrames.get(id)?.contentWindow?.history.forward();
    } catch {
      /* cross-origin — nothing to do */
    }
  }

  openPreviewExternal(id: string): void {
    const tab = this.snap.previewTabs.find((t) => t.id === id);
    if (tab?.port != null) window.open(this.wc.preview.url(tab.port, tab.path), "_blank");
  }

  previewSrc(tab: PreviewTab): string {
    return previewSrc(this.wc.preview, tab);
  }

  onPreviewFrameLoad(id: string): void {
    try {
      const title = this.previewFrames.get(id)?.contentDocument?.title;
      if (title) this.updatePreviewTab(id, { title });
    } catch {
      /* cross-origin document — no title to read */
    }
  }

  // ── command palette ─────────────────────────────────────────────────────
  openPalette(mode: PaletteMode): void {
    this.set({ paletteOpen: true, paletteMode: mode });
  }

  closePalette(): void {
    this.set({ paletteOpen: false });
  }
}
