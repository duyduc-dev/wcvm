// Node's real REPL persists top-level `let`/`const`/`class` across separate lines because it
// reuses one vm.Context (and V8's REPL-mode compilation) across every line it runs - a feature
// with no plain-JS equivalent: two separate indirect eval() calls in the same realm do NOT share
// lexical bindings (confirmed empirically - `(0,eval)("let x=1")` then `(0,eval)("x")` throws
// ReferenceError in Chromium), only `var`/function declarations attach to the real global object
// and persist. Since we deliberately don't vendor `vm` (see PLAN.md's known differences), rewrite
// top-level let/const to var before evaluating: declared names stay usable on later lines, at the
// cost of losing const's reassignment protection and let's redeclaration error (documented known
// REPL differences).

import type { AnyNode } from "./esm/ast";

export interface IReplAcorn {
  Parser: { parse(input: string, options: { sourceType: "script"; ecmaVersion: "latest" }): AnyNode };
}

/**
 * Rewrites this line's TOP-LEVEL `let`/`const` declarations to `var` (nested ones, e.g. inside
 * a block or a `for (let ...)`, are left alone - only genuine top-level declarations need to
 * survive to the next line). Returns the source unchanged if it doesn't parse: the REPL still
 * evaluates it, letting the real engine's own SyntaxError surface instead of acorn's.
 */
export const liftTopLevelDeclarations = (acorn: IReplAcorn, source: string): string => {
  let program: AnyNode;
  try {
    program = acorn.Parser.parse(source, { sourceType: "script", ecmaVersion: "latest" });
  } catch {
    return source;
  }

  const keywords: Array<{ start: number; end: number }> = [];
  for (const node of program.body as AnyNode[]) {
    const kind = node.kind as string | undefined;
    if (node.type === "VariableDeclaration" && (kind === "let" || kind === "const")) {
      keywords.push({ start: node.start, end: node.start + kind.length });
    }
  }
  if (keywords.length === 0) return source;

  keywords.sort((a, b) => b.start - a.start); // apply back-to-front so earlier offsets stay valid
  let out = source;
  for (const { start, end } of keywords) out = `${out.slice(0, start)}var${out.slice(end)}`;
  return out;
};
