import type * as Monaco from "monaco-editor";

// Monaco ships Monarch grammars for html/javascript/typescript/handlebars but none for the
// single-file-component formats of Vue and Svelte, or Ember's `<template>` tag in .gjs/.gts - so
// those files used to open as plain text with no colours. Each grammar below is Monaco's OWN
// grammar for the host language, cloned, with a few rules added in front. Embedded languages
// (`nextEmbedded`) are Monaco's real ones, so a `<script lang="ts">` block or a `{expr}` is
// tokenised by the real TypeScript/JavaScript grammar, not approximated.

type Rule = unknown[];
interface IMonarchLanguage {
  tokenizer: Record<string, Rule[]>;
  tokenPostfix?: string;
  [key: string]: unknown;
}
interface IDefinitionModule {
  conf: Monaco.languages.LanguageConfiguration;
  language: IMonarchLanguage;
}

const clone = <T>(value: T): T => {
  // Monarch grammars hold RegExps, which structuredClone/JSON can't copy - clone by hand.
  if (value instanceof RegExp) return value as T;
  if (Array.isArray(value)) return value.map(clone) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clone(v)])) as T;
  }
  return value;
};

/** A copy of an <script>/<style> opening-tag state whose closing `>` embeds `language` instead. */
const withEmbedded = (state: Rule[], embedded: string, nextState: string): Rule[] =>
  (clone(state) as Rule[]).map((rule) => {
    const action = rule[1] as { nextEmbedded?: string; next?: string } | undefined;
    if (action && typeof action === "object" && "nextEmbedded" in action) {
      return [rule[0], { ...action, nextEmbedded: embedded, next: nextState }];
    }
    return rule;
  });

/** html's tokenizer + `lang="ts"` / `lang="scss"` support on <script>/<style> + extra root rules. */
const buildMarkupLanguage = (
  html: IDefinitionModule,
  postfix: string,
  extend: (tokenizer: IMonarchLanguage["tokenizer"]) => void,
): IMonarchLanguage => {
  const language = clone(html.language);
  language.tokenPostfix = postfix;
  const t = language.tokenizer;

  // <script lang="ts"> -> the real TypeScript grammar; any other lang falls back to JavaScript.
  t.script!.unshift([/lang/, "attribute.name", "@scriptAfterLang"]);
  t.scriptAfterLang = [
    [/=/, "delimiter"],
    [/"(?:ts|tsx)"|'(?:ts|tsx)'/, { token: "attribute.value", switchTo: "@scriptTs" }],
    [/"([^"]*)"|'([^']*)'/, { token: "attribute.value", switchTo: "@script" }],
    [/[ \t\r\n]+/],
    [/>/, { token: "@rematch", switchTo: "@script" }],
  ];
  t.scriptTs = withEmbedded(t.script!, "typescript", "@scriptEmbedded");
  t.scriptTs!.unshift([/lang/, "attribute.name", "@scriptAfterLang"]);

  // <style lang="scss|less"> likewise.
  t.style!.unshift([/lang/, "attribute.name", "@styleAfterLang"]);
  t.styleAfterLang = [
    [/=/, "delimiter"],
    [/"scss"|'scss'/, { token: "attribute.value", switchTo: "@styleScss" }],
    [/"less"|'less'/, { token: "attribute.value", switchTo: "@styleLess" }],
    [/"([^"]*)"|'([^']*)'/, { token: "attribute.value", switchTo: "@style" }],
    [/[ \t\r\n]+/],
    [/>/, { token: "@rematch", switchTo: "@style" }],
  ];
  t.styleScss = withEmbedded(t.style!, "scss", "@styleEmbedded");
  t.styleLess = withEmbedded(t.style!, "less", "@styleEmbedded");

  extend(t);
  return language;
};

const vueExtensions = (t: IMonarchLanguage["tokenizer"]): void => {
  // {{ expression }} in text
  t.root!.unshift(
    [/\{\{/, { token: "delimiter.curly", next: "@mustache", nextEmbedded: "javascript" }],
    [/\}\}/, "delimiter.curly"],
  );
  t.mustache = [
    [/\}\}/, { token: "@rematch", next: "@pop", nextEmbedded: "@pop" }],
    [/[^}]+/, ""],
    [/\}/, ""],
  ];
  // v-if / :prop / @click / #slot directive names stand out from plain attributes
  t.otherTag!.unshift([/(?:v-[\w:.-]+|[:@#][\w:.-]+)/, "keyword"]);
};

const svelteExtensions = (t: IMonarchLanguage["tokenizer"]): void => {
  const expression: Rule = [/\{/, { token: "delimiter.curly", next: "@svelteExpr", nextEmbedded: "javascript" }];
  const closer: Rule = [/\}/, "delimiter.curly"];
  // {#if x} {:else} {/if} {@html x}: the block keyword, then a JavaScript expression.
  t.root!.unshift(
    [/(\{)([#:/@])(\w+)/, ["delimiter.curly", "keyword", { token: "keyword", next: "@svelteExpr", nextEmbedded: "javascript" }]],
    expression,
    closer,
  );
  t.otherTag!.unshift(expression, closer);
  t.svelteExpr = [
    [/\}/, { token: "@rematch", next: "@pop", nextEmbedded: "@pop" }],
    [/\{/, { token: "", next: "@svelteNested" }],
    [/[^{}]+/, ""],
  ];
  t.svelteNested = [
    [/\{/, { token: "", next: "@push" }],
    [/\}/, { token: "", next: "@pop" }],
    [/[^{}]+/, ""],
  ];
};

/** `.astro`: a `---` fenced TypeScript frontmatter at the very top, then HTML with `{expressions}`. */
const astroExtensions = (t: IMonarchLanguage["tokenizer"]): void => {
  const expression: Rule = [/\{/, { token: "delimiter.curly", next: "@astroExpr", nextEmbedded: "typescript" }];
  const closer: Rule = [/\}/, "delimiter.curly"];
  t.root!.unshift(expression, closer);
  t.otherTag!.unshift(expression, closer);
  t.astroExpr = [
    [/\}/, { token: "@rematch", next: "@pop", nextEmbedded: "@pop" }],
    [/\{/, { token: "", next: "@astroNested" }],
    [/[^{}]+/, ""],
  ];
  t.astroNested = [
    [/\{/, { token: "", next: "@push" }],
    [/\}/, { token: "", next: "@pop" }],
    [/[^{}]+/, ""],
  ];

  // The frontmatter is only a frontmatter as the file's FIRST thing: a separate start state decides,
  // then hands over to the HTML grammar (`switchTo`, so a later `---` line in the markup is plain text).
  t.htmlRoot = t.root!;
  t.frontmatterEnd = [[/^---\s*$/, { token: "delimiter", switchTo: "@htmlRoot" }]];
  t.root = [
    [/^---\s*$/, { token: "delimiter", switchTo: "@frontmatterBody", nextEmbedded: "typescript" }],
    [/./, { token: "@rematch", switchTo: "@htmlRoot" }],
  ];
  t.frontmatterBody = [
    [/^---\s*$/, { token: "@rematch", switchTo: "@frontmatterEnd", nextEmbedded: "@pop" }],
    [/[^-]+/, ""],
    [/-/, ""],
  ];
};

/** JS/TS grammar + Ember's `<template>...</template>` region, embedded as Handlebars. */
const buildTemplateTagLanguage = (base: IDefinitionModule, postfix: string): IMonarchLanguage => {
  const language = clone(base.language);
  language.tokenPostfix = postfix;
  language.tokenizer.root!.unshift(
    [/<template>/, { token: "tag", next: "@templateTag", nextEmbedded: "handlebars" }],
    [/<\/template>/, "tag"],
  );
  language.tokenizer.templateTag = [
    [/<\/template>/, { token: "@rematch", next: "@pop", nextEmbedded: "@pop" }],
    [/[^<]+/, ""],
    [/</, ""],
  ];
  return language;
};

let registered = false;

/** Registers vue, svelte, astro, gjs and gts with Monaco. Idempotent; the grammars are loaded lazily
 * (they're Monaco's own modules, already in the bundle for the built-in languages). */
export async function registerExtraLanguages(monaco: typeof Monaco): Promise<void> {
  if (registered) return;
  registered = true;
  // Monaco's grammar modules ship without type declarations (TS7016) - hence the directives.
  const [html, javascript, typescript] = (await Promise.all([
    // @ts-expect-error TS7016: no declaration file
    import("monaco-editor/languages/definitions/html/html.js"),
    // @ts-expect-error TS7016: no declaration file
    import("monaco-editor/languages/definitions/javascript/javascript.js"),
    // @ts-expect-error TS7016: no declaration file
    import("monaco-editor/languages/definitions/typescript/typescript.js"),
  ])) as unknown as IDefinitionModule[];

  const define = (id: string, extensions: string[], conf: IDefinitionModule["conf"], language: IMonarchLanguage) => {
    monaco.languages.register({ id, extensions, aliases: [id] });
    monaco.languages.setLanguageConfiguration(id, conf);
    monaco.languages.setMonarchTokensProvider(id, language as unknown as Monaco.languages.IMonarchLanguage);
  };

  define("vue", [".vue"], html.conf, buildMarkupLanguage(html, ".vue", vueExtensions));
  define("svelte", [".svelte"], html.conf, buildMarkupLanguage(html, ".svelte", svelteExtensions));
  define("astro", [".astro"], html.conf, buildMarkupLanguage(html, ".astro", astroExtensions));
  define("gjs", [".gjs"], javascript.conf, buildTemplateTagLanguage(javascript, ".gjs"));
  define("gts", [".gts"], typescript.conf, buildTemplateTagLanguage(typescript, ".gts"));
}
