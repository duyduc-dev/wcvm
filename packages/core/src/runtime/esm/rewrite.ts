// Rewrites one module's source so the browser's own ESM loader can run it:
// static import/export specifiers become the blob URL already prepared for
// that dependency (must be known before this module can be blobbed itself -
// see loader.ts's dependency-first ordering), every `import(...)` call -
// literal or computed argument alike - becomes a call to our own runtime
// bridge, since a dynamic import's target is only ever known once the
// argument expression actually runs, and every `import.meta` becomes this
// module's own meta object (its real `file://` URL - the browser's own
// `import.meta` would describe the blob, not the file).

import { dynamicImportCalls, importMetaProperties, staticImportSpecifiers, type AnyNode } from "./ast";

export const DYNAMIC_IMPORT_BRIDGE = "__wcvm_dynamic_import__";
export const IMPORT_META_BRIDGE = "__wcvm_import_meta__";

interface IEdit {
  start: number;
  end: number;
  replacement: string;
}

/**
 * @param resolveStatic Maps a static specifier's literal text (as written,
 *   quotes included) to its dependency's already-prepared blob URL.
 * @param selfUrl This module's own resolved path/URL, passed to the dynamic
 *   import bridge so it can resolve a relative specifier the same way this
 *   module itself was reached.
 */
export const rewriteModule = (source: string, program: AnyNode, resolveStatic: (specifierText: string) => string, selfUrl: string): string => {
  const edits: IEdit[] = [];

  for (const spec of staticImportSpecifiers(program, source)) {
    edits.push({ start: spec.start, end: spec.end, replacement: JSON.stringify(resolveStatic(spec.value)) });
  }
  for (const call of dynamicImportCalls(program)) {
    // Only the `import(` and the closing `)` (with any options argument before it) are replaced,
    // never the argument itself: it may hold edits of its own (`import(new URL("./x",
    // import.meta.url).href)`), which must not overlap these.
    edits.push({ start: call.start, end: call.argStart, replacement: `${DYNAMIC_IMPORT_BRIDGE}(` });
    edits.push({ start: call.argEnd, end: call.end, replacement: `, ${JSON.stringify(selfUrl)})` });
  }
  for (const meta of importMetaProperties(program)) {
    edits.push({ start: meta.start, end: meta.end, replacement: `${IMPORT_META_BRIDGE}(${JSON.stringify(selfUrl)})` });
  }

  edits.sort((a, b) => b.start - a.start); // apply back-to-front so earlier offsets stay valid
  let out = source;
  for (const edit of edits) out = out.slice(0, edit.start) + edit.replacement + out.slice(edit.end);
  return out;
};
