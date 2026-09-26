export const STATUS_MESSAGE_TIMEOUT_MS = 4000;

export const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "bmp",
  "ico",
  "svg",
]);

/** Extension (lowercase, no dot) -> Monaco language id. Unknown extensions fall back to "plaintext". */
export const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  md: "markdown",
  mdx: "markdown",
  yml: "yaml",
  yaml: "yaml",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  sql: "sql",
  xml: "xml",
  py: "python",
  go: "go",
  rs: "rust",
  java: "java",
  php: "php",
  rb: "ruby",
  toml: "ini",
  ini: "ini",
};

/** Never shown in the Explorer tree (VS Code hides `.git` by default too) — the VFS and a real
 * terminal `ls` still see it fine. */
export const HIDDEN_IN_TREE = new Set([".git"]);

/** Also skipped when walking the tree for quick-open (⌘P): `node_modules` can hold thousands of
 * files that would swamp the file list for little benefit. */
export const HIDDEN_IN_QUICK_OPEN = new Set([".git", "node_modules"]);

export const QUICK_OPEN_FILE_LIMIT = 5000;

export const EDITOR_FONT_FAMILY = "'JetBrains Mono Variable', ui-monospace, monospace";
