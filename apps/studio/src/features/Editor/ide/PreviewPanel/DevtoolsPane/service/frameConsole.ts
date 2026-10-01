import { formatArgs, formatValue } from "./format";

export type ConsoleLevel = "log" | "info" | "warn" | "error" | "debug" | "input" | "result";

export interface ConsoleEntry {
  id: number;
  level: ConsoleLevel;
  text: string;
}

const HOOKED_LEVELS = ["log", "info", "warn", "error", "debug"] as const;
const MAX_ENTRIES = 1000;

/** Collects one preview frame's console output and runtime errors, and evaluates expressions in
 * it. The preview iframe is same-origin (the preview Service Worker relay needs that), so this
 * reaches straight into its `window` - no injected script, no postMessage protocol.
 *
 * A page's own scripts can run before `load` fires, so waiting for the iframe's `load` event would
 * miss everything they log. A navigation swaps in a new `document`, so a per-frame watcher
 * compares `contentWindow.document` on every animation frame and hooks the new one as soon as it
 * exists - before its module scripts have been fetched. */
export class FrameConsole {
  private entries: ConsoleEntry[] = [];
  private nextId = 1;
  private version = 0;
  private listeners = new Set<() => void>();
  private frame: HTMLIFrameElement | null = null;
  private raf = 0;
  private hookedDoc: Document | null = null;
  private hookedUrl = "";

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  /** Bumps on every entry and every document swap; a stable primitive for `useSyncExternalStore`. */
  getVersion = (): number => this.version;

  getEntries(): readonly ConsoleEntry[] {
    return this.entries;
  }

  /** The frame's current (non-blank) document, or null before the first navigation. */
  get document(): Document | null {
    return this.hookedDoc;
  }

  get window(): (Window & typeof globalThis) | null {
    try {
      return (this.hookedDoc?.defaultView as (Window & typeof globalThis) | null) ?? null;
    } catch {
      return null;
    }
  }

  private bump(): void {
    this.version++;
    for (const cb of this.listeners) cb();
  }

  push(level: ConsoleLevel, text: string): void {
    this.entries.push({ id: this.nextId++, level, text });
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    this.bump();
  }

  clear(): void {
    this.entries = [];
    this.bump();
  }

  attach(frame: HTMLIFrameElement | null): void {
    if (frame === this.frame) return;
    cancelAnimationFrame(this.raf);
    this.frame = frame;
    if (!frame) return;
    const tick = (): void => {
      this.check();
      this.raf = requestAnimationFrame(tick);
    };
    tick();
  }

  detach(): void {
    cancelAnimationFrame(this.raf);
    this.frame = null;
  }

  private check(): void {
    let win: (Window & typeof globalThis) | null;
    let doc: Document | null;
    try {
      win = this.frame?.contentWindow as (Window & typeof globalThis) | null;
      doc = win?.document ?? null;
    } catch {
      return; // cross-origin: nothing to hook
    }
    if (!win || !doc || doc === this.hookedDoc) return;
    const url = win.location.href;
    if (url === "about:blank") {
      // The throw-away initial document; a hook here would just be lost on the first navigation.
      if (this.hookedDoc) {
        this.hookedDoc = null;
        this.bump();
      }
      return;
    }
    this.hookedDoc = doc;
    if (url !== this.hookedUrl || this.entries.length > 0) {
      this.entries = [];
      this.hookedUrl = url;
    }
    this.hook(win);
    this.bump();
  }

  private hook(win: Window & typeof globalThis): void {
    const c = win.console;
    for (const level of HOOKED_LEVELS) {
      const original = c[level].bind(c);
      c[level] = (...args: unknown[]) => {
        this.push(level, formatArgs(args));
        original(...args);
      };
    }
    const originalClear = c.clear.bind(c);
    c.clear = () => {
      this.clear();
      originalClear();
    };
    const originalAssert = c.assert.bind(c);
    c.assert = (cond?: boolean, ...args: unknown[]) => {
      if (!cond) this.push("error", "Assertion failed" + (args.length ? ": " + formatArgs(args) : ""));
      originalAssert(cond, ...args);
    };
    win.addEventListener("error", (e) => {
      const where = e.filename ? ` (${e.filename}:${e.lineno}:${e.colno})` : "";
      this.push("error", `Uncaught ${e.error?.stack ? String(e.error.stack) : e.message}${e.error?.stack ? "" : where}`);
    });
    win.addEventListener("unhandledrejection", (e) => {
      this.push("error", `Uncaught (in promise) ${formatValue(e.reason, 1)}`);
    });
  }

  /** Exposes the inspected element to the page's console as `$0`, like DevTools. */
  setInspected(el: Element | null): void {
    const win = this.window as (Window & { $0?: Element | null }) | null;
    if (win) win.$0 = el;
  }

  /** Evaluates `expression` in the page (global scope, like DevTools' console). */
  evaluate(expression: string): void {
    this.push("input", expression);
    const win = this.window;
    if (!win) {
      this.push("error", "No page is loaded in this tab.");
      return;
    }
    try {
      const value: unknown = (0, win.eval)(expression);
      if (value && typeof (value as { then?: unknown }).then === "function") {
        this.push("result", "Promise {<pending>}");
        (value as Promise<unknown>).then(
          (v) => this.push("result", `Promise resolved: ${formatValue(v, 1)}`),
          (e) => this.push("error", `Promise rejected: ${formatValue(e, 1)}`),
        );
      } else {
        this.push("result", formatValue(value, 1));
      }
    } catch (error) {
      this.push("error", formatValue(error, 1));
    }
  }
}

const stores = new Map<string, FrameConsole>();

export const getFrameConsole = (tabId: string): FrameConsole => {
  let store = stores.get(tabId);
  if (!store) {
    store = new FrameConsole();
    stores.set(tabId, store);
  }
  return store;
};

export const disposeFrameConsole = (tabId: string): void => {
  stores.get(tabId)?.detach();
  stores.delete(tabId);
};
