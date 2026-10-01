import type * as Monaco from "monaco-editor";
import { basename, dirname } from "../fs.service";
import { relativeSpecifier } from "../completions.service";
import { getComponentFiles } from "../typescript.service";
import { scriptBlocks } from "./shadowScript";

/** Source text with `//` and block comments blanked, so a commented-out `import Foo ...` doesn't
 * count as an import (offsets are preserved). */
export const withoutComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/[^\n]*/g, (m, lead: string | undefined) =>
    (lead ?? "") + m.slice((lead ?? "").length).replace(/[^\n]/g, " "),
  );

/** Component names already imported in the file's script blocks. */
export const importedComponentNames = (text: string): Set<string> => {
  const names = new Set<string>();
  for (const { start, end } of scriptBlocks(text)) {
    const code = withoutComments(text.slice(start, end));
    for (const m of code.matchAll(/import\s+([A-Z][\w$]*)\s*(?:,|from)/g)) names.add(m[1]);
  }
  return names;
};

/** `Counter.svelte` -> `Counter`, `my-card.vue` -> `MyCard`, `Foo/index.vue` -> `Foo`. */
export const componentNameOf = (path: string): string => {
  let base = basename(path).replace(/\.[^.]+$/, "");
  if (base === "index") base = basename(dirname(path));
  const pascal = base.replace(/(?:^|[^A-Za-z0-9]+)([A-Za-z0-9])/g, (_m, c: string) => c.toUpperCase());
  return /^[A-Za-z]/.test(pascal) ? pascal : `C${pascal}`;
};

export interface IComponentImport {
  name: string;
  spec: string;
}

/** Project `.vue` / `.svelte` files that aren't imported here yet, as `{ name, spec }`. */
export function importableComponents(currentPath: string, text: string): IComponentImport[] {
  const have = importedComponentNames(text);
  const out: IComponentImport[] = [];
  for (const path of getComponentFiles()) {
    if (path === currentPath) continue;
    const name = componentNameOf(path);
    if (have.has(name)) continue;
    out.push({ name, spec: relativeSpecifier(currentPath, path, true) });
  }
  return out;
}

/** Adds `import name from "spec"` to the file's script block (creating one if there is none). */
export function componentImportEdit(
  model: Monaco.editor.ITextModel,
  flavor: "vue" | "svelte",
  { name, spec }: IComponentImport,
): Monaco.languages.TextEdit {
  const text = model.getValue();
  const blocks = scriptBlocks(text);
  // The instance script: for Svelte not `<script module>`, for Vue prefer `<script setup>`.
  const block =
    blocks.find((b) => (flavor === "vue" ? /\bsetup\b/.test(b.open) : !/\bmodule\b|context\s*=\s*["']module["']/.test(b.open))) ??
    blocks[0];
  const at = (offset: number): Monaco.IRange => {
    const p = model.getPositionAt(offset);
    return { startLineNumber: p.lineNumber, startColumn: p.column, endLineNumber: p.lineNumber, endColumn: p.column };
  };

  if (!block) {
    const open = flavor === "vue" ? "<script setup>" : "<script>";
    return { range: at(0), text: `${open}\n  import ${name} from "${spec}";\n</script>\n\n` };
  }

  const code = withoutComments(text.slice(block.start, block.end));
  const imports = [...code.matchAll(/^[ \t]*import\b[^;]*?["'][^"']+["'];?[ \t]*$/gm)];
  const sample = imports.at(-1)?.[0] ?? "";
  const quote = sample.includes("'") && !sample.includes('"') ? "'" : '"';
  const semi = imports.length === 0 || sample.trimEnd().endsWith(";") ? ";" : "";
  const statement = `import ${name} from ${quote}${spec}${quote}${semi}`;

  const last = imports.at(-1);
  if (last) {
    const indent = /^[ \t]*/.exec(last[0])?.[0] ?? "";
    return { range: at(block.start + last.index + last[0].length), text: `\n${indent}${statement}` };
  }
  const firstLine = /^\n([ \t]*)\S/.exec(text.slice(block.start, block.end));
  return { range: at(block.start), text: `\n${firstLine?.[1] ?? "  "}${statement}` };
}
