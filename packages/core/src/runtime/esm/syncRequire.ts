// Rewrites one ES module's source into a plain, SYNCHRONOUS function body, so `require()` can
// load it - real Node 24's `require(esm)`. A native `import()` is inherently async (the browser
// loads a Blob URL), so this is a separate path from loader.ts's Blob-URL rewrite: instead of
// handing the browser a module, the source is turned into code that runs inside cjs.ts's own
// module wrapper, with its imports satisfied by a synchronous `__wcvm_import_sync__(specifier)`
// call (cjs.ts resolves it with the ESM conditions and recursively loads the target the same way).
//
// Shape of the result, in order:
//   1. Getters for every export this module DECLARES ITSELF, defined on the namespace FIRST - before
//      any import is evaluated - so a genuinely circular import sees the live (TDZ-shaped) getters
//      instead of a partial snapshot. Same idea as cyclic.ts's registry, minus the Blob machinery.
//   2. One `const __wcvm_imp_N__ = __wcvm_import_sync__("specifier")` per distinct specifier
//      (imports are hoisted in real ESM, so evaluating them all up front is faithful).
//   3. Re-exports (`export { a } from`, `export * from`) wired on top of those.
//   4. The module body: `import`/`export` statements removed or stripped down to the declaration
//      they wrap, and every free reference to an imported binding replaced with a LIVE property
//      read off its `__wcvm_imp_N__` namespace object (`freeReferences`, the same scope-aware pass
//      cyclic.ts uses).
//
// A top-level `await` needs no detection here: the result is compiled as a plain (non-async)
// function body, so it's a SyntaxError, which cjs.ts reports as ERR_REQUIRE_ASYNC_MODULE - the
// same error and the same reason real Node gives.

import { importBindingsOf, moduleExports, staticImportSpecifiers, type AnyNode, type IAcorn } from "./ast";
import { dynamicAndMetaEdits, type IEdit } from "./rewrite";
import { freeReferences } from "./scopeRewrite";

export const IMPORT_SYNC_BRIDGE = "__wcvm_import_sync__";
/** The namespace object the rewritten module populates - a private name, since the module's own
 *  code may legitimately declare `exports`. */
export const EXPORTS_PARAM = "__wcvm_exports__";

const propKey = (name: string): string => `[${JSON.stringify(name)}]`;

const nameOf = (node: AnyNode): string => {
  const n = node as AnyNode & { name?: string; value?: string };
  return n.name ?? String(n.value);
};

export const rewriteEsmForSyncRequire = (source: string, program: AnyNode, selfPath: string, acorn: IAcorn): string => {
  const edits: IEdit[] = dynamicAndMetaEdits(program, selfPath, acorn);
  const importVars = new Map<string, string>(); // specifier text -> const name
  const importLines: string[] = [];
  const replacementFor = new Map<string, string>(); // imported local name -> live read expression
  const reexports: { publicName: string; expr: string }[] = [];
  const stars: string[] = []; // namespace vars to `export *` from
  const varFor = (specifier: string): string => {
    let name = importVars.get(specifier);
    if (!name) {
      name = `__wcvm_imp_${importVars.size}__`;
      importVars.set(specifier, name);
      importLines.push(`const ${name} = ${IMPORT_SYNC_BRIDGE}(${JSON.stringify(specifier)});`);
    }
    return name;
  };

  for (const spec of staticImportSpecifiers(program, source)) {
    const node = spec.node;
    const ns = varFor(spec.value);
    edits.push({ start: node.start, end: node.end, replacement: "" });
    if (node.type === "ImportDeclaration") {
      const bindings = importBindingsOf(node)!;
      if (bindings.namespaceLocal) replacementFor.set(bindings.namespaceLocal, ns);
      if (bindings.defaultLocal) replacementFor.set(bindings.defaultLocal, `${ns}${propKey("default")}`);
      for (const { imported, local } of bindings.named) replacementFor.set(local, `${ns}${propKey(imported)}`);
    } else if (node.type === "ExportAllDeclaration") {
      if (node.exported) reexports.push({ publicName: nameOf(node.exported as AnyNode), expr: ns });
      else stars.push(ns);
    } else {
      for (const s of node.specifiers as AnyNode[]) {
        reexports.push({ publicName: nameOf(s.exported as AnyNode), expr: `${ns}${propKey(nameOf(s.local as AnyNode))}` });
      }
    }
  }

  for (const ref of freeReferences(program, new Set(replacementFor.keys()))) {
    const name = source.slice(ref.start, ref.end);
    const expr = replacementFor.get(name)!;
    edits.push({ start: ref.start, end: ref.end, replacement: ref.shorthand ? `${name}: ${expr}` : expr });
  }

  const live = (localExpr: string): string => replacementFor.get(localExpr) ?? localExpr;
  const getters: { publicName: string; expr: string }[] = [];
  const declared = moduleExports(program, source);
  for (const { publicName, localExpr } of declared.named) getters.push({ publicName, expr: live(localExpr) });

  for (const node of program.body as AnyNode[]) {
    if (node.type === "ExportNamedDeclaration" && !node.source) {
      const decl = node.declaration as AnyNode | null;
      // `export const x = 1` / `export function f() {}` keep their declaration, minus `export `;
      // a bare `export { a, b as c }` has nothing left once its getters exist.
      edits.push({ start: node.start, end: decl ? decl.start : node.end, replacement: "" });
    } else if (node.type === "ExportDefaultDeclaration") {
      const decl = node.declaration as AnyNode;
      if (decl.type === "Identifier") {
        edits.push({ start: node.start, end: node.end, replacement: "" });
        getters.push({ publicName: "default", expr: live(decl.name as string) });
      } else if ((decl.type === "FunctionDeclaration" || decl.type === "ClassDeclaration") && decl.id) {
        edits.push({ start: node.start, end: decl.start, replacement: "" });
        getters.push({ publicName: "default", expr: (decl.id as AnyNode & { name: string }).name });
      } else {
        // Anonymous function/class or a plain expression: capture it in a fresh binding. Only the
        // `export default ` PREFIX is replaced (not the whole statement), so any reference inside
        // the expression still gets its own edit above without overlapping this one.
        edits.push({ start: node.start, end: decl.start, replacement: "const __wcvm_default__ = " });
        edits.push({ start: node.end, end: node.end, replacement: ";" });
        getters.push({ publicName: "default", expr: "__wcvm_default__" });
      }
    }
  }

  // A reference inside a statement that's being removed outright (`export default importedName;`)
  // has nothing left to rewrite - drop its edit rather than overlap the removal's.
  const removals = edits.filter((e) => e.replacement === "" && e.end > e.start);
  const live_edits = edits.filter((e) => e.replacement === "" || !removals.some((r) => r.start <= e.start && e.end <= r.end));
  edits.length = 0;
  edits.push(...live_edits);
  edits.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < edits.length; i++) {
    if (edits[i]!.start < edits[i - 1]!.end) throw new Error(`internal error: overlapping edits in sync ESM rewrite of '${selfPath}'`);
  }
  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  let body = source;
  for (const edit of edits) body = body.slice(0, edit.start) + edit.replacement + body.slice(edit.end);

  const define = ({ publicName, expr }: { publicName: string; expr: string }) =>
    `Object.defineProperty(${EXPORTS_PARAM}, ${JSON.stringify(publicName)}, { enumerable: true, get() { return ${expr}; } });`;
  const hasDefault = getters.some((g) => g.publicName === "default") || reexports.some((r) => r.publicName === "default");
  // A module namespace lists its keys alphabetically (by code unit) - real Node's require(esm)
  // returns exactly that, so define the statically known ones in that order (names an `export *`
  // adds later come after).
  const byName = (a: { publicName: string }, b: { publicName: string }) => (a.publicName < b.publicName ? -1 : a.publicName > b.publicName ? 1 : 0);
  const prologue = [
    ...[...getters, ...reexports].sort(byName).map(define),
    ...importLines,
    ...stars.map(
      (ns) =>
        `for (const k of Object.keys(${ns})) if (k !== "default" && !Object.prototype.hasOwnProperty.call(${EXPORTS_PARAM}, k)) ` +
        `Object.defineProperty(${EXPORTS_PARAM}, k, { enumerable: true, get() { return ${ns}[k]; } });`,
    ),
    // What real Node's require(esm) does so a bundler-style `mod.__esModule ? mod.default : mod`
    // consumer picks the default export off a real ES module's namespace.
    hasDefault
      ? `if (!Object.prototype.hasOwnProperty.call(${EXPORTS_PARAM}, "__esModule")) Object.defineProperty(${EXPORTS_PARAM}, "__esModule", { value: true });`
      : "",
  ].join("\n");

  // A block of its own: the module's top-level let/const/class/function declarations (which may
  // reuse any of the wrapper's parameter names - vite's own modules declare `__dirname`) live in
  // this scope instead of colliding with the function's parameters.
  return `{\n${prologue}\n${body}\n}`;
};
