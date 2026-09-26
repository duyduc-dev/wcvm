export type CommandId =
  | "toggle-explorer"
  | "toggle-terminal"
  | "toggle-preview"
  | "new-terminal"
  | "save-file"
  | "toggle-theme";

export interface CommandDef {
  id: CommandId;
  label: string;
  keys?: string;
}

/** Every entry here must correspond to a real, wired-up action — no placeholders for
 * capabilities the sandbox doesn't have (git, debug, notebooks, remote import...). */
export const COMMANDS: CommandDef[] = [
  { id: "toggle-explorer", label: "Toggle Explorer", keys: "⌘B" },
  { id: "toggle-terminal", label: "Toggle Terminal", keys: "⌘J" },
  { id: "toggle-preview", label: "Toggle Preview", keys: "⌥⌘B" },
  { id: "new-terminal", label: "New Terminal", keys: "⇧⌘C" },
  { id: "save-file", label: "Save File", keys: "⌘S" },
  { id: "toggle-theme", label: "Toggle Theme" },
];

export const QUICK_OPEN_RESULT_LIMIT = 200;
