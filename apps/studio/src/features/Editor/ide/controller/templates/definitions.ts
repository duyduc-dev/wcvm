import type * as Monaco from "monaco-editor";
import { componentFor } from "./angular";
import { importedComponentNames, withoutComments } from "./componentImport";
import { scanTemplate } from "./scanner";
import { scriptBlocks, shadowOf } from "./shadowScript";

// Go to Definition for the template formats Monaco has no language service for. The target is
// always a plain Location; the cross-file "open that tab" part is the editor opener in IdeController.

type Location = Monaco.languages.Location;

const locationAt = (model: Monaco.editor.ITextModel, start: number, length: number): Location => {
  const from = model.getPositionAt(start);
  const to = model.getPositionAt(start + length);
  return {
    uri: model.uri,
    range: { startLineNumber: from.lineNumber, startColumn: from.column, endLineNumber: to.lineNumber, endColumn: to.column },
  };
};

export const wordAt = (text: string, offset: number): { word: string; start: number } | null => {
  let start = offset;
  let end = offset;
  while (start > 0 && /[\w$]/.test(text[start - 1])) start--;
  while (end < text.length && /[\w$]/.test(text[end])) end++;
  return end > start ? { word: text.slice(start, end), start } : null;
};

export const isMemberAccess = (text: string, wordStart: number): boolean => /\??\.\s*$/.test(text.slice(0, wordStart));

interface INavItem {
  text: string;
  nameSpan?: { start: number; length: number };
  childItems?: INavItem[];
}

/** TypeScript's own definitions for a position inside a `<script>` block (via the shadow model),
 * mapped back to the real `.vue` / `.svelte` file where they point into the shadow. */
async function scriptDefinitions(monaco: typeof Monaco, model: Monaco.editor.ITextModel, offset: number): Promise<Location[]> {
  const shadow = shadowOf(monaco, model);
  const getWorker = await monaco.typescript.getTypeScriptWorker();
  const worker = await getWorker(shadow.uri);
  const defs = (await worker.getDefinitionAtPosition(shadow.uri.toString(), offset)) ?? [];
  const out: Location[] = [];
  for (const d of defs as { fileName: string; textSpan: { start: number; length: number } }[]) {
    const uri = monaco.Uri.parse(d.fileName);
    const target = uri.toString() === shadow.uri.toString() ? model : monaco.editor.getModel(uri);
    if (target) out.push(locationAt(target, d.textSpan.start, d.textSpan.length));
  }
  return out;
}

/** The script-level declaration (`const x`, `function f`, an import, a destructured prop) a template
 * expression's identifier refers to - found from the shadow model's navigation tree. */
export async function scriptDeclaration(monaco: typeof Monaco, model: Monaco.editor.ITextModel, name: string): Promise<Location[]> {
  const shadow = shadowOf(monaco, model);
  const getWorker = await monaco.typescript.getTypeScriptWorker();
  const worker = await getWorker(shadow.uri);
  const tree = (await worker.getNavigationTree(shadow.uri.toString())) as INavItem | undefined;
  const item = tree?.childItems?.find((c) => c.text === name && c.nameSpan);
  return item?.nameSpan ? [locationAt(model, item.nameSpan.start, item.nameSpan.length)] : [];
}

const resolveRelative = (fromPath: string, spec: string): string => {
  const out = fromPath.split("/").slice(0, -1);
  for (const part of spec.split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/") || "/";
};

/** `<Counter />` -> the top of the component file it was imported from. */
function componentFile(monaco: typeof Monaco, model: Monaco.editor.ITextModel, name: string): Location[] {
  const text = model.getValue();
  if (!importedComponentNames(text).has(name)) return [];
  for (const { start, end } of scriptBlocks(text)) {
    const code = withoutComments(text.slice(start, end));
    const spec = new RegExp(`import\\s+${name}\\s*(?:,[^;]*?)?from\\s*["']([^"']+)["']`).exec(code)?.[1];
    if (!spec || !spec.startsWith(".")) continue;
    const target = monaco.editor.getModel(monaco.Uri.file(resolveRelative(model.uri.path, spec)));
    if (target) return [{ uri: target.uri, range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 } }];
  }
  return [];
}

export function registerTemplateDefinitions(monaco: typeof Monaco): void {
  for (const flavor of ["vue", "svelte"] as const) {
    monaco.languages.registerDefinitionProvider(flavor, {
      async provideDefinition(model, position) {
        const text = model.getValue();
        const offset = model.getOffsetAt(position);
        const ctx = scanTemplate(text, offset, flavor);
        const hit = wordAt(text, offset);
        if (!hit) return [];
        switch (ctx.kind) {
          case "script":
            return scriptDefinitions(monaco, model, offset);
          case "tag-name":
            return componentFile(monaco, model, hit.word);
          case "expression":
          case "attr-value":
            return isMemberAccess(text, hit.start) ? [] : scriptDeclaration(monaco, model, hit.word);
          default:
            return [];
        }
      },
    });
  }

  // Angular: an identifier in `{{ }}` / `(click)="..."` / `[x]="..."` -> the member in the component
  // class; `<app-child>` -> the class whose `selector` is `app-child`.
  monaco.languages.registerDefinitionProvider("html", {
    provideDefinition(model, position) {
      const component = componentFor(monaco, model);
      if (!component) return [];
      const text = model.getValue();
      const offset = model.getOffsetAt(position);
      const ctx = scanTemplate(text, offset, "angular");
      const source = component.getValue();

      if (ctx.kind === "expression" || ctx.kind === "attr-value") {
        const hit = wordAt(text, offset);
        if (!hit || isMemberAccess(text, hit.start)) return [];
        const classStart = /\bclass\s+[\w$]+[^{]*\{/.exec(source);
        const from = classStart ? classStart.index + classStart[0].length : 0;
        const member = new RegExp(`^[ \\t]+(?:(?:public|protected|private|readonly|static|override|async|get|set|declare)[ \\t]+)*(${hit.word})\\b`, "m").exec(source.slice(from));
        return member ? [locationAt(component, from + member.index + member[0].lastIndexOf(hit.word), hit.word.length)] : [];
      }

      if (ctx.kind === "tag-name") {
        const hit = wordAt(text, offset);
        const tag = /[\w-]*$/.exec(text.slice(0, offset))?.[0] + (/^[\w-]*/.exec(text.slice(offset))?.[0] ?? "");
        if (!hit || !tag) return [];
        for (const m of monaco.editor.getModels()) {
          if (m.uri.scheme !== "file" || !m.uri.path.endsWith(".ts") || m.uri.path.endsWith(".d.ts")) continue;
          const sel = new RegExp(`selector\\s*:\\s*['"\`](${tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})['"\`]`).exec(m.getValue());
          if (sel) return [locationAt(m, sel.index + sel[0].indexOf(sel[1]), sel[1].length)];
        }
      }
      return [];
    },
  });
}
