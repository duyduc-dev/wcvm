import type * as Monaco from "monaco-editor";

// Vue and Svelte put TypeScript/JavaScript in `<script>` blocks. Monaco's TS worker only understands
// whole `.ts` files, so each such file gets a hidden "shadow" TypeScript model: the same text with
// everything outside the script blocks blanked to spaces (newlines kept), so an offset in the real
// file is the same offset in the shadow. The TS worker then answers completions for it - with the
// real project's imports, types and node_modules typings, because the shadow lives beside the file.

const SCRIPT_BLOCK = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;

export const scriptBlocks = (text: string): { start: number; end: number; open: string }[] =>
  [...text.matchAll(SCRIPT_BLOCK)].map((m) => {
    const start = m.index + m[0].indexOf(">") + 1;
    return { start, end: start + m[1].length, open: m[0].slice(0, m[0].indexOf(">") + 1) };
  });

export function maskNonScript(text: string): string {
  const out = text.replace(/[^\n]/g, " ").split("");
  for (const { start, end } of scriptBlocks(text)) {
    for (let i = start; i < end; i++) out[i] = text[i];
  }
  return out.join("");
}

interface IShadow {
  model: Monaco.editor.ITextModel;
  dispose: () => void;
}
const shadows = new Map<string, IShadow>();

/** The shadow TS model of `model`, created on first use and kept in step with it. */
export function shadowOf(monaco: typeof Monaco, model: Monaco.editor.ITextModel): Monaco.editor.ITextModel {
  const key = model.uri.toString();
  const existing = shadows.get(key);
  if (existing) return existing.model;
  const uri = model.uri.with({ path: `${model.uri.path}.__script.ts` });
  const shadow = monaco.editor.getModel(uri) ?? monaco.editor.createModel(maskNonScript(model.getValue()), "typescript", uri);
  const sub = model.onDidChangeContent(() => shadow.setValue(maskNonScript(model.getValue())));
  const dispose = (): void => {
    sub.dispose();
    willDispose.dispose();
    shadow.dispose();
    shadows.delete(key);
  };
  const willDispose = model.onWillDispose(dispose);
  shadows.set(key, { model: shadow, dispose });
  return shadow;
}

interface ITsEntry {
  name: string;
  kind: string;
  kindModifiers?: string;
  sortText: string;
  insertText?: string;
}

const kindOf = (monaco: typeof Monaco, tsKind: string): Monaco.languages.CompletionItemKind => {
  const K = monaco.languages.CompletionItemKind;
  switch (tsKind) {
    case "function":
    case "local function":
      return K.Function;
    case "method":
    case "construct":
      return K.Method;
    case "property":
    case "getter":
    case "setter":
      return K.Property;
    case "class":
    case "local class":
      return K.Class;
    case "interface":
      return K.Interface;
    case "enum":
      return K.Enum;
    case "module":
    case "external module name":
      return K.Module;
    case "keyword":
      return K.Keyword;
    case "const":
    case "let":
    case "var":
    case "local var":
    case "parameter":
      return K.Variable;
    case "type":
    case "type parameter":
      return K.TypeParameter;
    case "alias":
      return K.Reference;
    default:
      return K.Text;
  }
};

/** TS completions at `offset` of `model`'s shadow, as Monaco items replacing `range`. `onlyLocals`
 * keeps declarations in scope (the script's own bindings and imports) and drops DOM/lib globals
 * and keywords - what a template expression can reference. */
export async function scriptCompletions(
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
  offset: number,
  range: Monaco.IRange,
  options: { onlyLocals?: boolean } = {},
): Promise<Monaco.languages.CompletionItem[]> {
  const shadow = shadowOf(monaco, model);
  const getWorker = await monaco.typescript.getTypeScriptWorker();
  const worker = await getWorker(shadow.uri);
  const info = (await worker.getCompletionsAtPosition(shadow.uri.toString(), offset)) as { entries: ITsEntry[] } | undefined;
  if (!info) return [];
  return info.entries
    .filter((e) => !options.onlyLocals || (e.sortText <= "12" && e.kind !== "keyword"))
    .map((e) => ({
      label: e.name,
      kind: kindOf(monaco, e.kind),
      insertText: e.insertText ?? e.name,
      sortText: e.sortText,
      range,
    }));
}
