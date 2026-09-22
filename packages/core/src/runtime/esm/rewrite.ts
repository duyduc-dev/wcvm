// Rewrites one module's source so the browser's own ESM loader can run it:
// static import/export specifiers become the blob URL already prepared for
// that dependency (must be known before this module can be blobbed itself -
// see loader.ts's dependency-first ordering), and every `import(...)` call -
// literal or computed argument alike - becomes a call to our own runtime
// bridge, since a dynamic import's target is only ever known once the
// argument expression actually runs.

import { dynamicImportCalls, staticImportSpecifiers, type AnyNode } from "./ast";

export const DYNAMIC_IMPORT_BRIDGE = "__wcvm_dynamic_import__";

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
    const argText = source.slice(call.argStart, call.argEnd);
    edits.push({ start: call.start, end: call.end, replacement: `${DYNAMIC_IMPORT_BRIDGE}(${argText}, ${JSON.stringify(selfUrl)})` });
  }

  edits.sort((a, b) => b.start - a.start); // apply back-to-front so earlier offsets stay valid
  let out = source;
  for (const edit of edits) out = out.slice(0, edit.start) + edit.replacement + out.slice(edit.end);
  return out;
};
