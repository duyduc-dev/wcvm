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
