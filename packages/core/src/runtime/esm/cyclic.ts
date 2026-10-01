// Rewrites ONE member of a genuinely circular ESM strongly-connected component (SCC) - see
// loader.ts's own doc comment for the full design, and why a plain per-edge dynamic-import bridge
// (a simpler design tried first) deadlocks instead of working: a dynamic `import()` of a module
// that's still mid-evaluation further up the SAME synchronous chain does not resolve early with
// whatever's been computed so far - it waits for that evaluation to finish, which can't happen if
// THAT evaluation is itself waiting on this same `import()`.
//
// Every import whose target is ANOTHER MEMBER OF THE SAME SCC (or itself, a self-loop) is removed
// entirely and replaced by a LIVE property read against a shared, per-key registry object
// (CYCLE_EXPORTS_BRIDGE) - never a native import, so there's no risk of re-entering a sibling's
// still-in-flight evaluation. Every OTHER import (outside the SCC, already fully prepared by the
// time this SCC is processed - see loader.ts) is left as an ordinary static import, unmodified,
// with real live bindings, exactly as today. This module's OWN exports are exposed to siblings by
// installing GETTERS on its own registry object, each one simply reading the real top-level local
// variable directly - the declarations themselves are never touched (only `export default <a
// non-identifier expression>` needs a small, safe rewrite - see ast.ts's `moduleExports`), so they
// keep every real ESM guarantee (TDZ, live bindings, declaration order) for this module's own
// code and for anyone OUTSIDE the cycle that imports it normally. A registry's properties are
// read via `Object.defineProperties`'s getters rather than a one-time snapshot specifically
// because a snapshot is exactly the "partial exports" hazard real Node's own circular `require()`
// already has (see runtime.test.ts's "hands a circular require the partial exports, like Node") -
// confirmed for real to actually break the target case (zod v4's own core.js/util.js cycle: one
// side's snapshot would capture `undefined` for a binding the other side hasn't declared yet at
// that exact synchronous instant, permanently, since a real usage is lazy - inside a function,
// called long after both sides have finished - but a `const` snapshot doesn't care when it's
// READ, only when it was TAKEN).

import { importBindingsOf, moduleExports, staticImportSpecifiers, type AnyNode, type IAcorn } from "./ast";
import { EsmResolveError } from "./resolve";
import { dynamicAndMetaEdits, type IEdit } from "./rewrite";
import { freeReferences } from "./scopeRewrite";

export const CYCLE_EXPORTS_BRIDGE = "__wcvm_cycle_exports__";
/** `(siblingKey, exportedName, assign)`: calls `assign(value)` as soon as the sibling's registry has
 * that property (immediately if it already does) - see the local-re-export handling below. */
export const CYCLE_READY_BRIDGE = "__wcvm_cycle_ready__";

/** A bracket-notation property read/definition key - safe for ANY exported name, including a
 *  reserved word (`.default`/`.import` are fine as PLAIN dot-access, but a rare string export name
 *  like `import { "a b" as x }` isn't a valid identifier at all) or the literal string `"default"`. */
const propKey = (name: string): string => `[${JSON.stringify(name)}]`;

/**
 * @param isCycleMember Maps a static specifier's literal text to the SIBLING's resolved key, if
 *   it's another member of this same SCC (or this module itself, self-loop) - `undefined` if it's
 *   an external dependency (outside this SCC, already prepared - see loader.ts).
 * @param resolveExternal For a specifier `isCycleMember` said `undefined` to: its ordinary,
 *   already-prepared blob URL, exactly like the non-cyclic `rewriteModule` path.
 * @param selfKey This module's own resolved key - both what its own registry is keyed by, and
 *   what's passed to the bridge so a sibling's forced-evaluation import can resolve relatively.
 */
export const rewriteCyclicModule = (
  source: string,
  program: AnyNode,
  isCycleMember: (specifierText: string) => string | undefined,
  resolveExternal: (specifierText: string) => string,
  selfKey: string,
  acorn: IAcorn,
): string => {
  const edits: IEdit[] = dynamicAndMetaEdits(program, selfKey, acorn);
  const cycleVarFor = new Map<string, string>(); // sibling key -> this module's own local var name
  const replacementFor = new Map<string, string>(); // originally-imported local name -> replacement expr
  // Where a removed import binding came from, for a local re-export of it (see below).
  const originFor = new Map<string, { siblingKey: string; imported: string | null }>(); // null = namespace
  const targetNames = new Set<string>();
  let cycleVarCounter = 0;

  for (const spec of staticImportSpecifiers(program, source)) {
    const siblingKey = isCycleMember(spec.value);
    if (siblingKey === undefined) {
      edits.push({ start: spec.start, end: spec.end, replacement: JSON.stringify(resolveExternal(spec.value)) });
      continue;
    }
    const bindings = importBindingsOf(spec.node);
    if (!bindings) {
      throw new EsmResolveError(
        "ERR_CIRCULAR_ESM_NOT_SUPPORTED",
        `Circular static ESM import involving '${siblingKey}' (via a re-export) is not supported yet ` +
          `(rewrite it as a plain import + a separate export, or use a dynamic import() to break the cycle)`,
      );
    }
    // The import declaration itself is replaced (the FIRST time this sibling is seen) with a
    // `const cycleVar = BRIDGE(...)` declaration, or removed entirely (any LATER import of the
    // same sibling - rare, but legal, to have more than one) - every one of its local bindings is
    // read LIVE off `cycleVar` at each use site instead (see the freeReferences pass below), never
    // introduced as a local variable of its own.
    let cycleVar = cycleVarFor.get(siblingKey);
    if (!cycleVar) {
      cycleVar = `__wcvm_cyc_${cycleVarCounter++}__`;
      cycleVarFor.set(siblingKey, cycleVar);
      edits.push({
        start: spec.node.start,
        end: spec.node.end,
        replacement: `const ${cycleVar} = ${CYCLE_EXPORTS_BRIDGE}(${JSON.stringify(siblingKey)});`,
      });
    } else {
      edits.push({ start: spec.node.start, end: spec.node.end, replacement: "" });
    }

    if (bindings.namespaceLocal) {
      replacementFor.set(bindings.namespaceLocal, cycleVar);
      originFor.set(bindings.namespaceLocal, { siblingKey, imported: null });
      targetNames.add(bindings.namespaceLocal);
    }
    if (bindings.defaultLocal) {
      replacementFor.set(bindings.defaultLocal, `${cycleVar}${propKey("default")}`);
      originFor.set(bindings.defaultLocal, { siblingKey, imported: "default" });
      targetNames.add(bindings.defaultLocal);
    }
    for (const { imported, local } of bindings.named) {
      replacementFor.set(local, `${cycleVar}${propKey(imported)}`);
      originFor.set(local, { siblingKey, imported });
      targetNames.add(local);
    }
  }

  for (const ref of freeReferences(program, targetNames)) {
    const name = source.slice(ref.start, ref.end);
    const expr = replacementFor.get(name)!;
    edits.push({ start: ref.start, end: ref.end, replacement: ref.shorthand ? `${name}: ${expr}` : expr });
  }

  // A LOCAL re-export (`export { a, b as c };`, no `from`) referencing one of the names just
  // removed above is a real SyntaxError waiting to happen - real ESM requires every bare export
  // specifier's local name to be an ACTUALLY DECLARED binding (var/let/const/function/class/import),
  // and the import that used to declare it is exactly what got removed (found for real:
  // @tanstack/router-core's own isServer/server.js does `import { loadServerRoute } from
  // "../load-server.js"; ...; export { isServer, loadServerRoute };` inside a genuine 3-module
  // cycle - "Export 'loadServerRoute' is not defined in module", a real V8 link-time error).
  //
  // Every one of the statement's names still gets a getter in the trailing registry block below, so
  // SIBLINGS read it live. But a module OUTSIDE the cycle imports this one with a plain native
  // `import { x }`, and the registry is invisible to it - so the first version of this fix, which
  // simply deleted the statement, left such a module with no export at all. Found for real with
  // Astro 6: `astro/runtime/server/index.js` re-exports `createComponent` (imported from a sibling
  // in its cycle) for the rest of the framework, and its namespace came out EMPTY ("does not
  // provide an export named 'createComponent'"). So each re-exported name is now a real native
  // export of this module: `let slot; export { slot as name };`, filled in by the bridge the moment
  // the sibling's registry has the value (a one-time copy, not a live binding - fine for the
  // functions/classes/consts that get re-exported, and the only way to have a native export
  // without a native import). Names in the same statement that are NOT cyclic stay ordinary
  // `export { ... }`.
  let reCounter = 0;
  for (const node of program.body as AnyNode[]) {
    if (node.type !== "ExportNamedDeclaration" || node.source || node.declaration) continue;
    const specifiers = node.specifiers as AnyNode[];
    const localOf = (spec: AnyNode) => (spec.local as AnyNode & { name: string }).name;
    const cyclic = specifiers.filter((spec) => replacementFor.has(localOf(spec)));
    if (cyclic.length === 0) continue;
    const kept = specifiers.filter((spec) => !replacementFor.has(localOf(spec)));
    const parts: string[] = [];
    if (kept.length > 0) parts.push(`export { ${kept.map((spec) => source.slice(spec.start, spec.end)).join(", ")} };`);
    for (const spec of cyclic) {
      const slot = `__wcvm_re_${reCounter++}__`;
      const origin = originFor.get(localOf(spec))!;
      const exported = spec.exported as AnyNode;
      parts.push(`let ${slot}; export { ${slot} as ${source.slice(exported.start, exported.end)} };`);
      parts.push(
        origin.imported === null
          ? `${slot} = ${cycleVarFor.get(origin.siblingKey)};`
          : `${CYCLE_READY_BRIDGE}(${JSON.stringify(origin.siblingKey)}, ${JSON.stringify(origin.imported)}, (value) => { ${slot} = value; });`,
      );
    }
    edits.push({ start: node.start, end: node.end, replacement: parts.join("\n") });
  }

  const exports = moduleExports(program, source);
  const localExprFor = (localExpr: string) => replacementFor.get(localExpr) ?? localExpr;
  if (exports.defaultExport?.edit) edits.push(exports.defaultExport.edit);

  edits.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < edits.length; i++) {
    if (edits[i]!.start < edits[i - 1]!.end) {
      throw new Error(`internal error: overlapping edits in cyclic ESM rewrite of '${selfKey}'`);
    }
  }
  // Back-to-front, so earlier offsets stay valid against the STILL-ORIGINAL text - but a
  // zero-width insertion and a same-start removal (the `const cycleVar = ...` line inserted right
  // before its own now-deleted import declaration) share a start, so ties need their own order:
  // the consuming (larger-end) edit first, or the insertion would be spliced against text that
  // already grew, cutting itself off.
  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  let out = source;
  for (const edit of edits) out = out.slice(0, edit.start) + edit.replacement + out.slice(edit.end);

  const registryProps = exports.named
    .map(({ publicName, localExpr }) => `${propKey(publicName)}: { get() { return ${localExprFor(localExpr)}; }, enumerable: true },`)
    .concat(
      exports.defaultExport
        ? [`${propKey("default")}: { get() { return ${localExprFor(exports.defaultExport.localExpr)}; }, enumerable: true },`]
        : [],
    )
    .join("\n  ");
  out += `\nObject.defineProperties(${CYCLE_EXPORTS_BRIDGE}(${JSON.stringify(selfKey)}), {\n  ${registryProps}\n});\n`;

  return out;
};
