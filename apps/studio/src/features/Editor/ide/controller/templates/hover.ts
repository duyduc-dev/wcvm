import type * as Monaco from "monaco-editor";
import { isMemberAccess, scriptDeclaration, wordAt } from "./definitions";
import { scanTemplate } from "./scanner";
import { shadowOf } from "./shadowScript";

// Hover for the template formats Monaco has no language service for: the type of a binding in a
// Vue / Svelte `<script>` block, and of the script binding a template expression refers to
// (`{count}`, `:title="label"`). Both are TypeScript's own quick info, asked of the file's hidden
// shadow model (shadowScript.ts), so they see the real project's imports and typings - including
// Svelte's runes: `let count = $state(0)` hovers as `let count: number`.

interface IPart {
  text: string;
}
interface IQuickInfo {
  textSpan: { start: number; length: number };
  displayParts?: IPart[];
  documentation?: IPart[];
}

const join = (parts?: IPart[]): string => (parts ?? []).map((p) => p.text).join("");

async function quickInfoAt(monaco: typeof Monaco, model: Monaco.editor.ITextModel, offset: number): Promise<IQuickInfo | undefined> {
  const shadow = shadowOf(monaco, model);
  const getWorker = await monaco.typescript.getTypeScriptWorker();
  const worker = await getWorker(shadow.uri);
  return (await worker.getQuickInfoAtPosition(shadow.uri.toString(), offset)) as IQuickInfo | undefined;
}

const rangeOf = (model: Monaco.editor.ITextModel, start: number, length: number): Monaco.IRange => {
  const from = model.getPositionAt(start);
  const to = model.getPositionAt(start + length);
  return { startLineNumber: from.lineNumber, startColumn: from.column, endLineNumber: to.lineNumber, endColumn: to.column };
};

/** A Vue attribute whose value is a script expression (`:title`, `@click`, `v-if`), as opposed to plain text. */
const isBoundAttribute = (attr: string): boolean => attr.startsWith(":") || attr.startsWith("@") || attr.startsWith("v-");

export function registerTemplateHover(monaco: typeof Monaco): void {
  for (const flavor of ["vue", "svelte"] as const) {
    monaco.languages.registerHoverProvider(flavor, {
      async provideHover(model, position) {
        const text = model.getValue();
        const offset = model.getOffsetAt(position);
        const ctx = scanTemplate(text, offset, flavor);

        let info: IQuickInfo | undefined;
        let range: Monaco.IRange | undefined;
        if (ctx.kind === "script") {
          info = await quickInfoAt(monaco, model, offset);
          if (info) range = rangeOf(model, info.textSpan.start, info.textSpan.length);
        } else if (ctx.kind === "expression" || (ctx.kind === "attr-value" && flavor === "vue" && isBoundAttribute(ctx.attr))) {
          const hit = wordAt(text, offset);
          if (!hit || isMemberAccess(text, hit.start)) return null;
          const [declaration] = await scriptDeclaration(monaco, model, hit.word);
          if (!declaration) return null;
          info = await quickInfoAt(monaco, model, model.getOffsetAt({ lineNumber: declaration.range.startLineNumber, column: declaration.range.startColumn }));
          range = rangeOf(model, hit.start, hit.word.length);
        }
        const display = join(info?.displayParts);
        if (!info || !range || !display) return null;

        const contents: Monaco.IMarkdownString[] = [{ value: "```typescript\n" + display + "\n```" }];
        const documentation = join(info.documentation);
        if (documentation) contents.push({ value: documentation });
        return { range, contents };
      },
    });
  }
}
