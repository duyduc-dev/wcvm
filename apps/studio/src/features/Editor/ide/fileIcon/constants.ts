/** Phosphor has no per-language logo icons (unlike vscode-icons), so file types are told apart
 * by tinting one shared glyph per extension group instead — enough to scan a tree quickly
 * without a full icon-per-language set. */
export const COLOR_BY_EXTENSION: Record<string, string> = {
  ts: "text-blue-500",
  tsx: "text-blue-500",
  mts: "text-blue-500",
  cts: "text-blue-500",
  js: "text-yellow-500",
  jsx: "text-yellow-500",
  mjs: "text-yellow-500",
  cjs: "text-yellow-500",
  json: "text-amber-600",
  jsonc: "text-amber-600",
  css: "text-sky-500",
  scss: "text-pink-400",
  sass: "text-pink-400",
  less: "text-indigo-400",
  html: "text-orange-500",
  htm: "text-orange-500",
  py: "text-emerald-600",
  go: "text-cyan-500",
  rs: "text-orange-600",
  java: "text-red-500",
  php: "text-violet-500",
  rb: "text-red-500",
  sh: "text-lime-600",
  bash: "text-lime-600",
  zsh: "text-lime-600",
  sql: "text-fuchsia-500",
  yml: "text-purple-400",
  yaml: "text-purple-400",
  xml: "text-orange-400",
  ini: "text-slate-400",
  toml: "text-slate-400",
};

export const IMAGE_ICON_COLOR = "text-purple-400";

export const DEFAULT_ICON_COLOR = "text-muted-foreground";
