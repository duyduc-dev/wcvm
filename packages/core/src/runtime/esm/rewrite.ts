// Rewrites one module's source so the browser's own ESM loader can run it:
// static import/export specifiers become the blob URL already prepared for
// that dependency (must be known before this module can be blobbed itself -
// see loader.ts's dependency-first ordering), every `import(...)` call -
// literal or computed argument alike - becomes a call to our own runtime
// bridge, since a dynamic import's target is only ever known once the
// argument expression actually runs, and every `import.meta` becomes this
// module's own meta object (its real `file://` URL - the browser's own
// `import.meta` would describe the blob, not the file).

import {
  dynamicImportCalls,
  importMetaProperties,
  nativeDynamicImportFunctions,
  staticImportSpecifiers,
  type AnyNode,
  type IAcorn,
} from "./ast";

export const DYNAMIC_IMPORT_BRIDGE = "__wcvm_dynamic_import__";
export const IMPORT_META_BRIDGE = "__wcvm_import_meta__";

export interface IEdit {
  start: number;
  end: number;
  replacement: string;
}

/** Every `import(...)` call (literal or computed argument, and the `new Function("x", "return
 *  import(x)")` idiom when `acorn` is given) and every `import.meta` - shared by `rewriteModule`
 *  and `cyclic.ts`'s `rewriteCyclicModule`, since a genuinely circular module can use dynamic
 *  imports and `import.meta` exactly like any other one; only its STATIC imports/exports need
 *  different treatment. */
export const dynamicAndMetaEdits = (program: AnyNode, selfUrl: string, acorn?: IAcorn): IEdit[] => {
  const edits: IEdit[] = [];
  for (const call of dynamicImportCalls(program)) {
    // Only the `import(` and the closing `)` (with any options argument before it) are replaced,
    // never the argument itself: it may hold edits of its own (`import(new URL("./x",
    // import.meta.url).href)`), which must not overlap these.
    edits.push({ start: call.start, end: call.argStart, replacement: `${DYNAMIC_IMPORT_BRIDGE}(` });
    edits.push({ start: call.argEnd, end: call.end, replacement: `, ${JSON.stringify(selfUrl)})` });
  }
  if (acorn) {
    for (const fn of nativeDynamicImportFunctions(acorn, program)) {
      // See ast.ts's own doc comment: a `new Function("x", "return import(x)")`-shaped function
      // hides its import() from this same AST-based rewrite (it's inert text inside a string
      // literal argument) so it would otherwise reach the browser's native import() completely
      // unresolved. Replace the whole call with an equivalent arrow function routed through the
      // same bridge - a bound closure, not a re-parsed string, so nothing is hidden from it.
      edits.push({
        start: fn.start,
        end: fn.end,
        replacement: `((${fn.params.join(",")}) => ${DYNAMIC_IMPORT_BRIDGE}(${fn.importParam}, ${JSON.stringify(selfUrl)}))`,
      });
    }
  }
  for (const meta of importMetaProperties(program)) {
    edits.push({ start: meta.start, end: meta.end, replacement: `${IMPORT_META_BRIDGE}(${JSON.stringify(selfUrl)})` });
  }
  return edits;
};

/**
 * @param resolveStatic Maps a static specifier's literal text (as written,
 *   quotes included) to its dependency's already-prepared blob URL.
 * @param selfUrl This module's own resolved path/URL, passed to the dynamic
 *   import bridge so it can resolve a relative specifier the same way this
 *   module itself was reached.
 */
export const rewriteModule = (source: string, program: AnyNode, resolveStatic: (specifierText: string) => string, selfUrl: string, acorn?: IAcorn): string => {
  const edits: IEdit[] = dynamicAndMetaEdits(program, selfUrl, acorn);

  for (const spec of staticImportSpecifiers(program, source)) {
    edits.push({ start: spec.start, end: spec.end, replacement: JSON.stringify(resolveStatic(spec.value)) });
  }

  edits.sort((a, b) => b.start - a.start); // apply back-to-front so earlier offsets stay valid
  let out = source;
  for (const edit of edits) out = out.slice(0, edit.start) + edit.replacement + out.slice(edit.end);
  return out;
};
