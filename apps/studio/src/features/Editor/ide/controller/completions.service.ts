import type * as Monaco from "monaco-editor";
import { basename, dirname } from "./fs.service";
import { getProjectContext, isProjectSource } from "./typescript.service";

// Monaco's TypeScript worker answers completions without the "include exports from other modules"
// preference, so it never suggests a symbol that still needs importing. This provider adds them:
// every exported name of every other project file is offered, and accepting one also inserts (or
// extends) the `import`. Exports are found with a regex over the model text - synchronous, works the
// same for .js and .ts, and doesn't depend on which of Monaco's two language workers owns a file.

const LANGUAGES = ["typescript", "javascript"];
const MAX_AUTO_IMPORTS = 300;

interface IExport {
  name: string;
  kind: Monaco.languages.CompletionItemKind;
  isDefault: boolean;
}

const exportsCache = new WeakMap<Monaco.editor.ITextModel, { version: number; exports: IExport[] }>();

const identifierFromFile = (path: string): string => {
  let base = basename(path).replace(/\.[^.]+$/, "");
  if (base === "index") base = basename(dirname(path));
  const camel = base.replace(/[^A-Za-z0-9_$]+(.)?/g, (_m, c: string | undefined) => (c ? c.toUpperCase() : ""));
  return /^[A-Za-z_$]/.test(camel) ? camel : `_${camel}`;
};

function exportsOf(monaco: typeof Monaco, model: Monaco.editor.ITextModel): IExport[] {
  const cached = exportsCache.get(model);
  if (cached && cached.version === model.getVersionId()) return cached.exports;
  const text = model.getValue();
  const { CompletionItemKind: K } = monaco.languages;
  const out: IExport[] = [];
  const seen = new Set<string>();
  const add = (name: string, kind: Monaco.languages.CompletionItemKind): void => {
    if (!seen.has(name)) {
      seen.add(name);
      out.push({ name, kind, isDefault: false });
    }
  };

  const declaration =
    /^export\s+(?:declare\s+)?(?:async\s+)?(function\*?|const|let|var|class|abstract\s+class|enum|interface|type)\s+([A-Za-z_$][\w$]*)/gm;
  for (const m of text.matchAll(declaration)) {
    const keyword = m[1].replace(/\*$/, "").replace(/^abstract\s+/, "");
    const kind =
      keyword === "function"
        ? K.Function
        : keyword === "class"
          ? K.Class
          : keyword === "enum"
            ? K.Enum
            : keyword === "interface" || keyword === "type"
              ? K.Interface
              : K.Variable;
    add(m[2], kind);
  }
  // `export { a, b as c }` (not `export { x } from "..."`, which re-exports without a local name
  // but is still importable - so both are included).
  for (const m of text.matchAll(/^export\s*(?:type\s*)?\{([^}]*)\}/gm)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name && /^[A-Za-z_$][\w$]*$/.test(name) && name !== "default") add(name, K.Variable);
    }
  }
  if (/^export\s+default\b/m.test(text)) out.push({ name: "", kind: K.Module, isDefault: true });

  exportsCache.set(model, { version: model.getVersionId(), exports: out });
  return out;
}

/** `./utils`, `../lib/format` - extension and `/index` dropped, always with a leading `./` or `../`. */
export function relativeSpecifier(fromFile: string, toFile: string): string {
  const from = dirname(fromFile).split("/").filter(Boolean);
  const to = toFile.replace(/\.(?:[cm]?[jt]s|[jt]sx)$/, "").replace(/\/index$/, "").split("/").filter(Boolean);
  let common = 0;
  while (common < from.length && common < to.length && from[common] === to[common]) common++;
  const ups = from.length - common;
  const rest = to.slice(common).join("/");
  const prefix = ups === 0 ? "./" : "../".repeat(ups);
  return prefix + rest;
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Already imported or declared here - suggesting it again would be a duplicate. */
const isBound = (text: string, name: string): boolean =>
  new RegExp(`import\\b[^;]*\\b${escapeRegExp(name)}\\b[^;]*?["'][^"']+["']`).test(text) ||
  new RegExp(`\\b(?:const|let|var|function|class|enum|interface|type)\\s+${escapeRegExp(name)}\\b`).test(text);

/** The edit that adds `name` (or the default binding) to an `import` from `spec`. */
function importEdit(
  model: Monaco.editor.ITextModel,
  spec: string,
  name: string,
  isDefault: boolean,
): Monaco.languages.TextEdit {
  const text = model.getValue();
  const semi = /;\s*$/m.test(text.match(/^import\b.*$/m)?.[0] ?? ";") ? ";" : "";
  const quote = /^import\b.*'/m.test(text) && !/^import\b.*"/m.test(text) ? "'" : '"';

  if (!isDefault) {
    const existing = new RegExp(`import\\s+(?:type\\s+)?(?:[\\w$]+\\s*,\\s*)?\\{([^}]*)\\}\\s*from\\s*(["'])${escapeRegExp(spec)}\\2`).exec(text);
    if (existing) {
      const open = existing.index + existing[0].indexOf("{") + 1;
      const close = open + existing[1].length;
      const names = existing[1].split(",").map((s) => s.trim()).filter(Boolean);
      const inline = !existing[1].includes("\n");
      const body = inline ? ` ${[...names, name].join(", ")} ` : `\n  ${[...names, name].join(",\n  ")},\n`;
      const start = model.getPositionAt(open);
      const end = model.getPositionAt(close);
      return {
        range: { startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column },
        text: body,
      };
    }
  }

  const statement = isDefault
    ? `import ${name} from ${quote}${spec}${quote}${semi}\n`
    : `import { ${name} } from ${quote}${spec}${quote}${semi}\n`;
  let line = 1;
  for (const m of text.matchAll(/^import\b[^;]*?["'][^"']+["'];?[ \t]*$/gm)) {
    line = model.getPositionAt(m.index + m[0].length).lineNumber + 1;
  }
  return {
    range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
    text: statement,
  };
}

const SNIPPETS: { label: string; detail: string; body: string }[] = [
  { label: "log", detail: "console.log()", body: "console.log($1);" },
  { label: "clg", detail: "console.log()", body: "console.log($1);" },
  { label: "cle", detail: "console.error()", body: "console.error($1);" },
  { label: "clw", detail: "console.warn()", body: "console.warn($1);" },
  { label: "cld", detail: "console.dir()", body: "console.dir($1, { depth: null });" },
  { label: "fn", detail: "function declaration", body: "function ${1:name}(${2:params}) {\n\t$0\n}" },
  { label: "afn", detail: "arrow function", body: "const ${1:name} = (${2:params}) => {\n\t$0\n};" },
  { label: "imp", detail: "import { } from", body: 'import { $2 } from "${1:module}";' },
  { label: "impd", detail: "import default from", body: 'import ${2:name} from "${1:module}";' },
  { label: "exp", detail: "export const", body: "export const ${1:name} = $0;" },
  { label: "forof", detail: "for...of loop", body: "for (const ${1:item} of ${2:items}) {\n\t$0\n}" },
  { label: "foreach", detail: "array.forEach()", body: "${1:items}.forEach((${2:item}) => {\n\t$0\n});" },
  { label: "try", detail: "try / catch", body: "try {\n\t$1\n} catch (${2:error}) {\n\t$0\n}" },
  { label: "settimeout", detail: "setTimeout()", body: "setTimeout(() => {\n\t$0\n}, ${1:1000});" },
  { label: "prom", detail: "new Promise", body: "new Promise((resolve, reject) => {\n\t$0\n})" },
];

export function registerProjectCompletions(monaco: typeof Monaco): void {
  const { CompletionItemKind: K, CompletionItemInsertTextRule } = monaco.languages;

  monaco.languages.registerCompletionItemProvider(LANGUAGES, {
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      const linePrefix = model.getLineContent(position.lineNumber).slice(0, word.startColumn - 1);
      // Member access (`foo.`) and import specifiers are the TS service's job.
      if (word.word === "" || /[.]\s*$/.test(linePrefix) || /^\s*import\b/.test(linePrefix)) {
        return { suggestions: [] };
      }

      const suggestions: Monaco.languages.CompletionItem[] = SNIPPETS.map((s) => ({
        label: s.label,
        kind: K.Snippet,
        detail: s.detail,
        insertText: s.body,
        insertTextRules: CompletionItemInsertTextRule.InsertAsSnippet,
        range,
        sortText: "0" + s.label,
      }));

      const ctx = getProjectContext();
      const here = model.uri.path;
      if (!ctx || !isProjectSource(here)) return { suggestions };
      const text = model.getValue();
      let count = 0;

      for (const other of monaco.editor.getModels()) {
        const path = other.uri.path;
        if (other === model || other.uri.scheme !== "file" || !isProjectSource(path) || /\.d\.[cm]?ts$/.test(path)) continue;
        const spec = relativeSpecifier(here, path);
        for (const exp of exportsOf(monaco, other)) {
          if (count >= MAX_AUTO_IMPORTS) break;
          const name = exp.isDefault ? identifierFromFile(path) : exp.name;
          if (!name.toLowerCase().startsWith(word.word.toLowerCase()) || isBound(text, name)) continue;
          count++;
          suggestions.push({
            label: { label: name, description: spec },
            kind: exp.kind,
            detail: `Auto import${exp.isDefault ? " (default)" : ""} from "${spec}"`,
            insertText: name,
            range,
            sortText: "z" + name,
            additionalTextEdits: [importEdit(model, spec, name, exp.isDefault)],
          });
        }
      }
      return { suggestions };
    },
  });

}
