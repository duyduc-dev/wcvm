export type TabKind = "text" | "image";

export interface DirEntry {
  name: string;
  path: string;
  dir: boolean;
}

export interface TerminalEntry {
  id: string;
  label: string;
  alive: boolean;
  /** What the terminal is busy with on the app's behalf ("Installing dependencies"): shown as a
   *  spinner on its tab and an indeterminate bar over it. */
  task?: string;
}

export interface PreviewTab {
  id: string;
  port: number | null;
  path: string;
  url: string;
  title?: string;
}

export type PaletteMode = "command" | "file";

export interface IdeSnapshot {
  rootPath: string;
  projectTitle: string;
  isDark: boolean;
  sidebarCollapsed: boolean;
  panelCollapsed: boolean;
  previewCollapsed: boolean;
  openTabs: string[];
  activeTab: string | null;
  previewTab: string | null;
  dirty: string[];
  tabKinds: Record<string, TabKind>;
  terminals: TerminalEntry[];
  activeTermId: string | null;
  previewTabs: PreviewTab[];
  activePreviewId: string | null;
  paletteOpen: boolean;
  paletteMode: PaletteMode;
  statusMessage: string | null;
  /** Bumped when the terminal may have changed files (output, a finished install): the Explorer
   *  reloads the folders it has open. */
  fsRevision: number;
}
