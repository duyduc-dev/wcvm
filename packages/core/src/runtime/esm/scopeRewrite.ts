// Finds every FREE reference (not shadowed by an intervening scope) to a set of names, anywhere
// in a module body - used by loader.ts's circular-import support to redirect a REMOVED import's
// local bindings to live property reads on a shared registry object, without touching some
// UNRELATED local variable that happens to reuse the same name in a nested scope. A generic
// "visit every node" walk (ast.ts's own `walk`) can't tell a reference from a declaration, or a
// property KEY (`{ x: 1 }`'s `x`, `obj.x`'s `x`) from a variable reference of the same name - this
// is a real (if deliberately scoped-down) JS lexical-scope analysis instead.
//
// Deliberately NOT handled (rare enough in real, modern, already-compiled npm output that a loud
// failure - an accidental ReferenceError from an unrewritten reference, never a silently WRONG
// value - is an acceptable trade-off against the size of a fully exhaustive implementation):
// `eval`/`with` (could introduce bindings this can't see at all), Annex B function-in-block
// legacy semantics, and `arguments`/`this` (irrelevant here - never one of our target names).

import type { AnyNode } from "./ast";

export interface IReference {
  start: number;
  end: number;
}

const collectPatternNames = (node: AnyNode | null | undefined, into: string[]): void => {
  if (!node) return;
  if (node.type === "Identifier") into.push(node.name as string);
  else if (node.type === "ObjectPattern") {
    for (const prop of node.properties as AnyNode[]) {
      collectPatternNames((prop.type === "RestElement" ? prop.argument : prop.value) as AnyNode, into);
    }
  } else if (node.type === "ArrayPattern") {
    for (const el of node.elements as (AnyNode | null)[]) collectPatternNames(el, into);
  } else if (node.type === "AssignmentPattern") collectPatternNames(node.left as AnyNode, into);
  else if (node.type === "RestElement") collectPatternNames(node.argument as AnyNode, into);
};

/** Every `var` and function-DECLARATION name reachable from `nodes` without crossing a nested
 *  function boundary (their body is a separate scope) - real JS hoists both all the way up to the
 *  nearest function (or Program) scope, regardless of how many blocks/if/for/try/switch lie
 *  between the declaration and that scope. A `FunctionDeclaration` itself still contributes its
 *  OWN name here (it binds in the scope that CONTAINS it), just not its params/body. */
const collectHoisted = (node: AnyNode | AnyNode[] | null | undefined, into: string[]): void => {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const item of node) collectHoisted(item, into);
    return;
  }
  switch (node.type) {
    case "VariableDeclaration":
      if (node.kind === "var") for (const d of node.declarations as AnyNode[]) collectPatternNames(d.id as AnyNode, into);
      return;
    case "FunctionDeclaration":
      if (node.id) collectPatternNames(node.id as AnyNode, into);
      return; // params/body are that function's own scope - do not descend
    case "BlockStatement":
      collectHoisted(node.body as AnyNode[], into);
      return;
    case "IfStatement":
      collectHoisted(node.consequent as AnyNode, into);
      collectHoisted(node.alternate as AnyNode | null, into);
      return;
    case "ForStatement":
      collectHoisted(node.init as AnyNode | null, into);
      collectHoisted(node.body as AnyNode, into);
      return;
    case "ForInStatement":
    case "ForOfStatement":
      collectHoisted(node.left as AnyNode, into);
      collectHoisted(node.body as AnyNode, into);
      return;
    case "WhileStatement":
    case "DoWhileStatement":
      collectHoisted(node.body as AnyNode, into);
      return;
    case "TryStatement":
      collectHoisted(node.block as AnyNode, into);
      if (node.handler) collectHoisted((node.handler as AnyNode).body as AnyNode, into);
      collectHoisted(node.finalizer as AnyNode | null, into);
      return;
    case "SwitchStatement":
      for (const c of node.cases as AnyNode[]) collectHoisted(c.consequent as AnyNode[], into);
      return;
    case "LabeledStatement":
      collectHoisted(node.body as AnyNode, into);
      return;
    default:
      return;
  }
};

/** `let`/`const`/`class`/function declarations DIRECTLY in one list of statements (a block's own
 *  body, or a Program's) - unlike `collectHoisted`, this does NOT recurse into nested blocks
 *  (`let`/`const`/`class` are block-scoped: a nested block's own declarations belong to ITS OWN
 *  frame, pushed separately when the walk actually reaches it). */
const collectBlockScoped = (statements: AnyNode[], into: string[]): void => {
  for (const node of statements) {
    if (node.type === "VariableDeclaration" && node.kind !== "var") {
      for (const d of node.declarations as AnyNode[]) collectPatternNames(d.id as AnyNode, into);
    } else if (node.type === "ClassDeclaration" && node.id) {
      collectPatternNames(node.id as AnyNode, into);
    } else if (node.type === "FunctionDeclaration" && node.id) {
      into.push((node.id as AnyNode & { name: string }).name); // already hoisted too; harmless to declare twice in a Set
    }
  }
};

class ScopeStack {
  private frames: Set<string>[] = [];
  push(names: string[] = []): void {
    this.frames.push(new Set(names));
  }
  pop(): void {
    this.frames.pop();
  }
  declare(name: string): void {
    this.frames[this.frames.length - 1]!.add(name);
  }
  /** Frame 0 is the module top level - a target name is never "declared" there (it's exactly the
   *  binding being replaced), so only a DEEPER frame counts as shadowing it. */
  isShadowed(name: string): boolean {
    for (let i = this.frames.length - 1; i >= 1; i--) if (this.frames[i]!.has(name)) return true;
    return false;
  }
}

/** Finds every free (non-shadowed) reference to one of `targetNames`, anywhere in `program`'s
 *  body - top-level import/export declarations excluded (the caller handles those separately). */
export const freeReferences = (program: AnyNode, targetNames: Set<string>): IReference[] => {
  const refs: IReference[] = [];
  const scopes = new ScopeStack();
  scopes.push(); // frame 0: the module top level itself

  const enterFunctionScope = (fn: AnyNode): void => {
    const names: string[] = [];
    if (fn.type === "FunctionExpression" && fn.id) collectPatternNames(fn.id as AnyNode, names); // visible to itself only
    for (const param of fn.params as AnyNode[]) collectPatternNames(param, names);
    if ((fn.body as AnyNode).type === "BlockStatement") {
      collectHoisted((fn.body as AnyNode).body as AnyNode[], names);
      collectBlockScoped((fn.body as AnyNode).body as AnyNode[], names);
    }
    scopes.push(names);
    if ((fn.body as AnyNode).type === "BlockStatement") for (const stmt of (fn.body as AnyNode).body as AnyNode[]) visit(stmt);
    else visit(fn.body as AnyNode); // a concise arrow body is an expression, not a block
    scopes.pop();
  };

  const enterBlock = (block: AnyNode): void => {
    const names: string[] = [];
    collectBlockScoped(block.body as AnyNode[], names);
    scopes.push(names);
    for (const stmt of block.body as AnyNode[]) visit(stmt);
    scopes.pop();
  };

  // Visits every child of `node` that isn't itself a full statement/expression handled by a more
  // specific case below - used for node shapes with no scoping meaning of their own.
  const visitChildren = (node: AnyNode): void => {
    for (const key of Object.keys(node)) {
      if (key === "type" || key === "start" || key === "end" || key === "loc" || key === "range") continue;
      const value = (node as Record<string, unknown>)[key];
      if (Array.isArray(value)) {
        for (const item of value as unknown[]) if (item && typeof item === "object") visit(item as AnyNode);
      } else if (value && typeof value === "object") {
        visit(value as unknown as AnyNode);
      }
    }
  };

  function visit(node: AnyNode): void {
    switch (node.type) {
      case "Identifier":
        if (targetNames.has(node.name as string) && !scopes.isShadowed(node.name as string)) refs.push({ start: node.start, end: node.end });
        return;

      case "MemberExpression":
        visit(node.object as AnyNode);
        if (node.computed) visit(node.property as AnyNode); // `obj[x]`: x is a real reference
        return; // `obj.x`: x is a property NAME, never a variable reference

      case "Property":
      case "PropertyDefinition": {
        // `{ [x]: 1 }` / `class { [x] = 1 }`: a computed key IS a reference; `{ x: 1 }`'s bare key
        // is not. Shorthand (`{ x }`) has `key` and `value` as the SAME reference - visiting
        // `value` alone already covers it once.
        if (node.computed) visit(node.key as AnyNode);
        if (node.value) visit(node.value as AnyNode);
        return;
      }

      case "MethodDefinition":
        if (node.computed) visit(node.key as AnyNode);
        if (node.value) visit(node.value as AnyNode);
        return;

      case "LabeledStatement":
        visit(node.body as AnyNode); // `label:` is a separate namespace, never a variable
        return;
      case "BreakStatement":
      case "ContinueStatement":
        return; // `.label` (if any) is not a variable reference

      case "MetaProperty":
        return; // `import.meta` / `new.target` - not a variable reference at all

      case "VariableDeclarator":
        // Declared names were already collected by the enclosing scope's own pre-pass.
        if (node.init) visit(node.init as AnyNode);
        // A destructuring default's OWN identifiers (`{ a = x } = ...`) are bindings, but any
        // EXPRESSION inside a default value (`{ a = someTargetName } = ...`) can reference a
        // target name for real - walk defaults' values via the pattern itself.
        visitPatternDefaults(node.id as AnyNode);
        return;

      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        enterFunctionScope(node);
        return;

      case "ClassDeclaration":
      case "ClassExpression":
        if (node.superClass) visit(node.superClass as AnyNode);
        scopes.push(node.id ? [(node.id as AnyNode).name as string] : []);
        for (const el of (node.body as AnyNode).body as AnyNode[]) visit(el);
        scopes.pop();
        return;

      case "BlockStatement":
        enterBlock(node);
        return;

      case "CatchClause": {
        const names: string[] = [];
        collectPatternNames(node.param as AnyNode | null, names);
        scopes.push(names);
        visitPatternDefaults(node.param as AnyNode | null);
        enterBlock(node.body as AnyNode);
        scopes.pop();
        return;
      }

      case "ForStatement": {
        const names: string[] = [];
        if (node.init && (node.init as AnyNode).type === "VariableDeclaration") collectBlockScopedDeclOnly(node.init as AnyNode, names);
        scopes.push(names);
        if (node.init) visit(node.init as AnyNode);
        if (node.test) visit(node.test as AnyNode);
        if (node.update) visit(node.update as AnyNode);
        visit(node.body as AnyNode);
        scopes.pop();
        return;
      }

      case "ForInStatement":
      case "ForOfStatement": {
        const names: string[] = [];
        if ((node.left as AnyNode).type === "VariableDeclaration") collectBlockScopedDeclOnly(node.left as AnyNode, names);
        scopes.push(names);
        visit(node.left as AnyNode);
        visit(node.right as AnyNode);
        visit(node.body as AnyNode);
        scopes.pop();
        return;
      }

      case "SwitchStatement": {
        visit(node.discriminant as AnyNode);
        const names: string[] = [];
        for (const c of node.cases as AnyNode[]) collectBlockScoped(c.consequent as AnyNode[], names);
        scopes.push(names);
        for (const c of node.cases as AnyNode[]) {
          if (c.test) visit(c.test as AnyNode);
          for (const stmt of c.consequent as AnyNode[]) visit(stmt);
        }
        scopes.pop();
        return;
      }

      // Import/export declarations are handled entirely by the caller (loader.ts/rewrite.ts) -
      // never descend into one here (a specifier's `local`/`imported`/`exported` are names, not
      // references, and a source string is not code).
      case "ImportDeclaration":
      case "ExportAllDeclaration":
        return;
      case "ExportNamedDeclaration":
        if (!node.source && node.declaration) visit(node.declaration as AnyNode);
        return;
      case "ExportDefaultDeclaration":
        // A function/class declaration here may be ANONYMOUS (`export default function() {}`) -
        // `visit()`'s own FunctionDeclaration/ClassDeclaration cases already tolerate a missing
        // `id`. A plain expression (`export default 42`) is just visited directly.
        visit(node.declaration as AnyNode);
        return;

      default:
        visitChildren(node);
        return;
    }
  }

  // A destructuring default's VALUE side can reference real bindings (`{ a = targetName } = x`);
  // walks just those, since the pattern's own identifiers were already collected as declarations.
  function visitPatternDefaults(pattern: AnyNode | null | undefined): void {
    if (!pattern) return;
    if (pattern.type === "AssignmentPattern") {
      visit(pattern.right as AnyNode);
      visitPatternDefaults(pattern.left as AnyNode);
    } else if (pattern.type === "ObjectPattern") {
      for (const prop of pattern.properties as AnyNode[]) {
        if (prop.type === "RestElement") visitPatternDefaults(prop.argument as AnyNode);
        else {
          if (prop.computed) visit(prop.key as AnyNode);
          visitPatternDefaults(prop.value as AnyNode);
        }
      }
    } else if (pattern.type === "ArrayPattern") {
      for (const el of pattern.elements as (AnyNode | null)[]) visitPatternDefaults(el);
    } else if (pattern.type === "RestElement") {
      visitPatternDefaults(pattern.argument as AnyNode);
    }
  }

  // `for (let x ...)` / `for (const [a,b] in ...)`: only THIS declaration's own pattern names,
  // never the hoisting/block-scoped scan of a whole statement list `collectBlockScoped` expects.
  function collectBlockScopedDeclOnly(decl: AnyNode, into: string[]): void {
    for (const d of decl.declarations as AnyNode[]) collectPatternNames(d.id as AnyNode, into);
  }

  // No hoisting pre-pass needed for the module top level itself: a target name is always one of a
  // REMOVED import's own local bindings, and real JS forbids ANY other top-level declaration
  // (var/let/const/function/another import) from reusing that exact name in the first place - so
  // frame 0 could never legally contain one anyway.
  for (const stmt of program.body as AnyNode[]) visit(stmt);

  return refs;
};
