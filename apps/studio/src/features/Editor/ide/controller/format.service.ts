import type * as Monaco from "monaco-editor";
import type { IFs } from "wcvm";
import type { Options, Plugin } from "prettier";
import { joinPath, readTextFile } from "./fs.service";

// Prettier, in the browser: its own `standalone` build plus the language plugins, all loaded
// lazily on the first format (they're several MB together) - nothing here runs, or is even
// downloaded, until someone asks to format a file.

interface IParserChoice {
  parser: string;
  plugins: () => Promise<Plugin[]>;
}

const babel = async () => [(await import("prettier/plugins/babel")).default, (await import("prettier/plugins/estree")).default] as Plugin[];
const typescript = async () => [(await import("prettier/plugins/typescript")).default, (await import("prettier/plugins/estree")).default] as Plugin[];
const postcss = async () => [(await import("prettier/plugins/postcss")).default] as Plugin[];
const html = async () => [(await import("prettier/plugins/html")).default] as Plugin[];
const markdown = async () => [(await import("prettier/plugins/markdown")).default] as Plugin[];
const yaml = async () => [(await import("prettier/plugins/yaml")).default] as Plugin[];
const glimmer = async () => [(await import("prettier/plugins/glimmer")).default] as Plugin[];
// <script>/<style> blocks inside a .vue/.svelte file are formatted by the real language plugins.
const withScripts = async (host: () => Promise<Plugin[]>) => [...(await host()), ...(await babel()), ...(await typescript()), ...(await postcss())];
const svelte = async () => [...(await withScripts(html)), (await import("prettier-plugin-svelte")) as unknown as Plugin];
// .gjs/.gts: the JS/TS around the templates is formatted as one of these, the <template> bodies as
// Handlebars - see formatTemplateTag below (Prettier has no parser for the combination, and the
// community plugin for it can't be bundled: CommonJS that require()s a top-level-await module).
const templateTag = async () => [...(await typescript()), ...(await babel()), ...(await glimmer())];

/** Monaco language id -> Prettier parser. Languages Prettier can't format are simply absent. */
const PARSERS: Record<string, IParserChoice> = {
  typescript: { parser: "typescript", plugins: typescript },
  javascript: { parser: "babel", plugins: babel },
  json: { parser: "json", plugins: babel },
  css: { parser: "css", plugins: postcss },
  scss: { parser: "scss", plugins: postcss },
  less: { parser: "less", plugins: postcss },
  html: { parser: "html", plugins: html },
  vue: { parser: "vue", plugins: () => withScripts(html) },
  svelte: { parser: "svelte", plugins: svelte },
  handlebars: { parser: "glimmer", plugins: glimmer },
  markdown: { parser: "markdown", plugins: markdown },
  yaml: { parser: "yaml", plugins: yaml },
  gjs: { parser: "babel", plugins: templateTag },
  gts: { parser: "typescript", plugins: templateTag },
};

export const FORMATTABLE_LANGUAGES = Object.keys(PARSERS);
export const canFormat = (languageId: string) => languageId in PARSERS;

/** The project's own Prettier settings, if it has any - `.prettierrc` / `.prettierrc.json`
 * (JSON) or a `"prettier"` key in package.json. Anything else (JS/YAML configs) is ignored. */
async function loadProjectConfig(fs: IFs, rootPath: string): Promise<Options> {
  for (const name of [".prettierrc", ".prettierrc.json"]) {
    try {
      return JSON.parse(await readTextFile(fs, joinPath(rootPath, name))) as Options;
    } catch {
      // missing, or not JSON (a YAML .prettierrc): try the next one
    }
  }
  try {
    const pkg = JSON.parse(await readTextFile(fs, joinPath(rootPath, "package.json"))) as { prettier?: Options };
    if (pkg.prettier && typeof pkg.prettier === "object") return pkg.prettier;
  } catch {
    // no package.json
  }
  return {};
}

export interface IFormatContext {
  fs: IFs;
  rootPath: string;
  /** Reports a failure (a syntax error, say) to the user - the formatter itself never throws
   * into Monaco, which would surface as an anonymous console error. */
  report: (message: string) => void;
}

// One Monaco instance and one set of formatting providers per page, but a different project (fs
// root) per editor session - so the providers read whichever context is current.
let context: IFormatContext | null = null;
export const setFormatContext = (next: IFormatContext | null): void => {
  context = next;
};

const indentLines = (text: string, indent: string): string =>
  text
    .split("\n")
    .map((line) => (line.trim() === "" ? "" : indent + line))
    .join("\n");

/** Formats a .gjs/.gts file: every `<template>...</template>` is swapped for a placeholder the JS
 * formatter treats as ordinary code, then each template body is formatted as Handlebars and put
 * back, indented under its tag. Which regions ARE templates comes from `content-tag` - the same
 * parser Ember's own build uses - so strings/comments containing "<template>" are never touched. */
async function formatTemplateTag(
  text: string,
  options: Options,
  format: (source: string, opts: Options) => Promise<string>,
): Promise<string> {
  const { Preprocessor } = await import("content-tag");
  const templates = new Preprocessor().parse(text, { filename: options.filepath });
  if (templates.length === 0) return format(text, options);

  // Replace back to front so earlier offsets stay valid.
  let masked = text;
  const ordered = templates.map((t, index) => ({ t, index })).sort((a, b) => b.t.range.startUtf16Codepoint - a.t.range.startUtf16Codepoint);
  const trailingSemicolon = new Map<number, boolean>();
  for (const { t, index } of ordered) {
    const { startUtf16Codepoint: start, endUtf16Codepoint: end } = t.range;
    trailingSemicolon.set(index, text[end] === ";");
    // An identifier, not a string: a bare `...` after a line with no semicolon would otherwise
    // parse as a tagged template; an identifier is separated from it by ASI.
    const placeholder = t.type === "class-member" ? `__GJS_TEMPLATE_${index}__ = 0;` : `__GJS_TEMPLATE_${index}__;`;
    masked = masked.slice(0, start) + placeholder + masked.slice(end);
  }

  let result = await format(masked, options);
  const tabWidth = options.tabWidth ?? 2;
  const printWidth = options.printWidth ?? 80;
  for (const { t, index } of ordered.slice().reverse()) {
    const body = t.contents.trim() === "" ? "" : (await format(t.contents, { ...options, parser: "glimmer", filepath: undefined, printWidth: Math.max(printWidth - tabWidth, 20) })).replace(/\s+$/, "");
    const marker = new RegExp(`^([ \\t]*)(.*?)(?:__GJS_TEMPLATE_${index}__ = 0;|__GJS_TEMPLATE_${index}__;?)`, "m");
    result = result.replace(marker, (_all, base: string, before: string) => {
      const unit = options.useTabs ? "\t" : " ".repeat(tabWidth);
      const inner = body ? `\n${indentLines(body, base + unit)}\n${base}` : "";
      const semicolon = t.type === "expression" && trailingSemicolon.get(index) ? ";" : "";
      return `${base}${before}<template>${inner}</template>${semicolon}`;
    });
  }
  return result;
}

export async function formatText(languageId: string, path: string, text: string, ctx: IFormatContext, tabSize: number): Promise<string> {
  const choice = PARSERS[languageId];
  if (!choice) throw new Error(`Prettier has no formatter for ${languageId}`);
  const [{ format }, plugins, project] = await Promise.all([
    import("prettier/standalone"),
    choice.plugins(),
    loadProjectConfig(ctx.fs, ctx.rootPath),
  ]);
  // The filepath lets the typescript/babel parsers pick JSX (.tsx/.jsx) over plain syntax.
  const options: Options = { tabWidth: tabSize, ...project, parser: choice.parser, plugins, filepath: path };
  if (languageId === "gjs" || languageId === "gts") return formatTemplateTag(text, options, format);
  return format(text, options);
}

let providersRegistered = false;

/** Makes Prettier Monaco's document formatter for every supported language, so Monaco's own
 * "Format Document" action (⇧⌥F, the context menu, the command palette) just works. */
export function registerFormatters(monaco: typeof Monaco): void {
  if (providersRegistered) return;
  providersRegistered = true;
  for (const languageId of FORMATTABLE_LANGUAGES) {
    monaco.languages.registerDocumentFormattingEditProvider(languageId, {
      displayName: "Prettier",
      async provideDocumentFormattingEdits(model, options) {
        const ctx = context;
        if (!ctx) return [];
        const original = model.getValue();
        try {
          const formatted = await formatText(languageId, model.uri.path, original, ctx, options.tabSize);
          if (formatted === original) return [];
          return [{ range: model.getFullModelRange(), text: formatted }];
        } catch (error) {
          // Prettier's syntax errors are multi-line with a code frame; the first line is the message.
          ctx.report(`Prettier: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`);
          return [];
        }
      },
    });
  }
}
