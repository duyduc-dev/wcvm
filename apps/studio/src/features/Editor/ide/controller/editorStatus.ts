export interface CursorInfo {
  line: number;
  column: number;
  selectedChars: number;
  selectionCount: number;
}

export interface EditorStatusSnapshot {
  cursor: CursorInfo | null;
  language: string | null;
}

const EMPTY: EditorStatusSnapshot = { cursor: null, language: null };

/** A tiny external store (same `subscribe`/`getSnapshot` shape as `IdeController` itself) so
 * StatusBar can read live cursor/language state via `useSyncExternalStore` — a keystroke or
 * cursor move updates just this, not the whole IdeSnapshot every other panel reads. */
export class EditorStatus {
  private listeners = new Set<() => void>();
  private snap: EditorStatusSnapshot = EMPTY;

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  getSnapshot = (): EditorStatusSnapshot => this.snap;

  set(partial: Partial<EditorStatusSnapshot>): void {
    this.snap = { ...this.snap, ...partial };
    for (const cb of this.listeners) cb();
  }
}
