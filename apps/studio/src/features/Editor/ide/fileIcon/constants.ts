/** A small coloured square carrying a short label - the same shape as the JS/TS marks in the
 * template picker, so every file type has its own recognisable icon without an icon-set
 * dependency. `fg` defaults to white. */
export interface IBadge {
  kind: "badge";
  label: string;
  bg: string;
  fg?: string;
}

/** A brand mark from the template picker (React, Vue, Svelte, Ember, Angular...). */
export interface IBrand {
  kind: "brand";
  brand: "react" | "vue" | "svelte" | "ember" | "angular" | "tailwind";
}

export type IFileIconSpec = IBadge | IBrand;

const badge = (label: string, bg: string, fg?: string): IBadge => ({ kind: "badge", label, bg, fg });
const brand = (name: IBrand["brand"]): IBrand => ({ kind: "brand", brand: name });

const TS = badge("TS", "#3178C6");
const JS = badge("JS", "#F7DF1E", "#000");
const JSON_ICON = badge("{}", "#CBA400", "#000");
const LOCK = badge("LOCK", "#6b7280");
const GIT = badge("GIT", "#F05032");
const ESLINT = badge("ES", "#4B32C3");
const PRETTIER = badge("PRT", "#1a2b34");
const VITE = badge("V", "#8b5cf6");

export const ICON_BY_EXTENSION: Record<string, IFileIconSpec> = {
  ts: TS,
  mts: TS,
  cts: TS,
  tsx: brand("react"),
  js: JS,
  mjs: JS,
  cjs: JS,
  jsx: brand("react"),
  json: JSON_ICON,
  jsonc: JSON_ICON,
  css: badge("CSS", "#1572B6"),
  scss: badge("SCSS", "#CD6799"),
  sass: badge("SASS", "#CD6799"),
  less: badge("LESS", "#1D365D"),
  html: badge("<>", "#E44D26"),
  htm: badge("<>", "#E44D26"),
  md: badge("MD", "#519ABA"),
  mdx: badge("MDX", "#FCB32C", "#000"),
  yml: badge("YML", "#CB171E"),
  yaml: badge("YML", "#CB171E"),
  xml: badge("XML", "#E37933"),
  toml: badge("TOML", "#9C4221"),
  ini: badge("INI", "#6b7280"),
  env: badge("ENV", "#ECD53F", "#000"),
  sh: badge("SH", "#4EAA25"),
  bash: badge("SH", "#4EAA25"),
  zsh: badge("SH", "#4EAA25"),
  sql: badge("SQL", "#E38C00"),
  py: badge("PY", "#3776AB"),
  go: badge("GO", "#00ADD8"),
  rs: badge("RS", "#DEA584", "#000"),
  java: badge("JV", "#E76F00"),
  php: badge("PHP", "#777BB4"),
  rb: badge("RB", "#CC342D"),
  txt: badge("TXT", "#6b7280"),
  lock: LOCK,
  log: badge("LOG", "#6b7280"),
  vue: brand("vue"),
  svelte: brand("svelte"),
  // Ember: component/template files
  gjs: brand("ember"),
  gts: brand("ember"),
  hbs: brand("ember"),
  handlebars: brand("ember"),
};

/** Exact (lowercase) file names - checked before the extension, so `package.json` isn't just
 * another JSON file. */
export const ICON_BY_FILENAME: Record<string, IFileIconSpec> = {
  "package.json": badge("npm", "#CB3837"),
  "package-lock.json": LOCK,
  "pnpm-lock.yaml": LOCK,
  "yarn.lock": LOCK,
  "bun.lockb": LOCK,
  "tsconfig.json": badge("TS", "#2b6cb0"),
  "tsconfig.app.json": badge("TS", "#2b6cb0"),
  "tsconfig.node.json": badge("TS", "#2b6cb0"),
  "jsconfig.json": badge("JS", "#d4b106", "#000"),
  "angular.json": brand("angular"),
  "ember-cli-build.mjs": brand("ember"),
  ".ember-cli": brand("ember"),
  ".gitignore": GIT,
  ".gitattributes": GIT,
  ".npmrc": badge("npm", "#CB3837"),
  ".nvmrc": badge("NVM", "#339933"),
  ".prettierrc": PRETTIER,
  ".prettierrc.json": PRETTIER,
  ".prettierignore": PRETTIER,
  "prettier.config.js": PRETTIER,
  "prettier.config.mjs": PRETTIER,
  ".eslintrc": ESLINT,
  ".eslintrc.json": ESLINT,
  ".eslintrc.js": ESLINT,
  "eslint.config.js": ESLINT,
  "eslint.config.mjs": ESLINT,
  ".editorconfig": badge("EC", "#6b7280"),
  "readme.md": badge("i", "#42a5f5"),
  "license": badge("LIC", "#d97706"),
  "license.md": badge("LIC", "#d97706"),
  dockerfile: badge("DKR", "#2496ED"),
  ".dockerignore": badge("DKR", "#2496ED"),
  "index.html": badge("<>", "#E44D26"),
  "babel.config.mjs": badge("B", "#F5DA55", "#000"),
  "babel.config.js": badge("B", "#F5DA55", "#000"),
  ".babelrc": badge("B", "#F5DA55", "#000"),
  "vite.config.ts": VITE,
  "vite.config.js": VITE,
  "vite.config.mjs": VITE,
  "tailwind.config.js": brand("tailwind"),
  "tailwind.config.ts": brand("tailwind"),
};

/** Shown for anything not listed above, and for TS declaration files' own variant. */
export const DECLARATION_ICON = badge("d.ts", "#4b8fd9");
export const IMAGE_ICON_COLOR = "text-purple-400";
export const DEFAULT_ICON_COLOR = "text-muted-foreground";
