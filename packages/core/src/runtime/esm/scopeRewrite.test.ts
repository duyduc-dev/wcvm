import { describe, expect, it } from "vitest";
import { createTestLoader } from "../testing";
import { parseModule } from "./ast";
import { freeReferences } from "./scopeRewrite";

const acorn = createTestLoader().require("internal/deps/acorn/acorn/dist/acorn");

/** Runs `freeReferences` and returns the exact source substrings it found - easier to assert
 *  against than raw offsets, and catches an off-by-one in start/end for free. */
const found = (source: string, names: string[] = ["target"]): string[] => {
  const program = parseModule(acorn, source, "/test.mjs");
  return freeReferences(program, new Set(names))
    .sort((a, b) => a.start - b.start)
    .map((r) => source.slice(r.start, r.end));
};

describe("freeReferences", () => {
  it("finds a plain top-level reference", () => {
    expect(found(`console.log(target);`)).toEqual(["target"]);
  });

  it("finds every reference when there are several", () => {
    expect(found(`const a = target + target;\nfoo(target);`)).toEqual(["target", "target", "target"]);
  });

  it("finds a reference inside a function body, called later", () => {
    expect(found(`function f() { return target; }`)).toEqual(["target"]);
  });

  it("finds a reference inside an arrow function's concise (expression) body", () => {
    expect(found(`const f = () => target;`)).toEqual(["target"]);
  });

  it("does NOT find a reference shadowed by a function parameter", () => {
    expect(found(`function f(target) { return target; }`)).toEqual([]);
  });

  it("does NOT find a reference shadowed by a destructured parameter", () => {
    expect(found(`function f({ target }) { return target; }`)).toEqual([]);
    expect(found(`function f([target]) { return target; }`)).toEqual([]);
    expect(found(`function f({ a: target }) { return target; }`)).toEqual([]);
  });

  it("does NOT find a reference shadowed by a nested let/const", () => {
    expect(found(`{ let target = 1; console.log(target); }`)).toEqual([]);
    expect(found(`{ const target = 1; console.log(target); }`)).toEqual([]);
  });

  it("DOES find a reference in a sibling block that does not shadow", () => {
    const out = found(`{ let target = 1; }\nconsole.log(target);`);
    expect(out).toEqual(["target"]);
  });

  it("does NOT find a reference shadowed by a var, even hoisted out of a nested block", () => {
    // Real JS: this `var` is hoisted to the function's own scope, so the later reference resolves
    // to IT, not to whatever's outside the function - the exact case a naive block-only scope
    // walk would get wrong.
    const source = `function f() {\n  if (true) { var target = 5; }\n  console.log(target);\n}`;
    expect(found(source)).toEqual([]);
  });

  it("does NOT find a reference shadowed by a function declared later in the same block (hoisting)", () => {
    const source = `function f() {\n  console.log(target);\n  function target() {}\n}`;
    expect(found(source)).toEqual([]);
  });

  it("does NOT find a reference shadowed by a class declaration", () => {
    expect(found(`{ class target {} console.log(target); }`)).toEqual([]);
  });

  it("does NOT find a reference shadowed by a catch parameter", () => {
    expect(found(`try {} catch (target) { console.log(target); }`)).toEqual([]);
  });

  it("does NOT find a reference shadowed by a for-of/for-in/for loop variable", () => {
    expect(found(`for (const target of []) console.log(target);`)).toEqual([]);
    expect(found(`for (const target in {}) console.log(target);`)).toEqual([]);
    expect(found(`for (let target = 0; target < 1; target++) {}`)).toEqual([]);
  });

  it("DOES find the loop's own iterable/init expression referencing the outer name", () => {
    expect(found(`for (const x of target) console.log(x);`)).toEqual(["target"]);
  });

  it("does NOT find a reference shadowed by a switch case's own let", () => {
    expect(found(`switch (x) { case 1: { let target = 1; console.log(target); } }`)).toEqual([]);
  });

  it("does NOT treat a non-computed member property as a reference", () => {
    expect(found(`console.log(obj.target);`)).toEqual([]);
  });

  it("DOES treat a computed member property as a reference", () => {
    expect(found(`console.log(obj[target]);`)).toEqual(["target"]);
  });

  it("does NOT treat a plain object literal key as a reference", () => {
    expect(found(`const o = { target: 1 };`)).toEqual([]);
  });

  it("DOES treat a shorthand object property as a reference (it's both a key and a value)", () => {
    expect(found(`const o = { target };`)).toEqual(["target"]);
  });

  it("DOES treat a computed object literal key as a reference", () => {
    expect(found(`const o = { [target]: 1 };`)).toEqual(["target"]);
  });

  it("does NOT treat a label, break or continue target as a reference", () => {
    expect(found(`target: for (;;) { break target; continue target; }`, ["target"])).toEqual([]);
  });

  it("does NOT descend into import/export specifiers or a source string", () => {
    expect(found(`import { target } from './x.js';`)).toEqual([]);
    expect(found(`export { target };\nconst target = 1;`)).toEqual([]);
  });

  it("DOES find a reference inside a plain exported declaration's initializer", () => {
    expect(found(`export const y = target;`)).toEqual(["target"]);
  });

  it("DOES find a reference inside export default's expression", () => {
    expect(found(`export default target;`)).toEqual(["target"]);
    expect(found(`export default { value: target };`)).toEqual(["target"]);
  });

  it("DOES find a reference inside a class field initializer and a computed method name", () => {
    expect(found(`class C { x = target; [target]() {} }`)).toEqual(["target", "target"]);
  });

  it("does NOT find a reference shadowed by a class's own name (visible inside itself)", () => {
    expect(found(`const C = class target { static x = target; };`)).toEqual([]);
  });

  it("DOES find a reference inside a destructuring default's value", () => {
    expect(found(`const { a = target } = {};`)).toEqual(["target"]);
  });

  it("DOES find a reference inside a dynamic import()'s computed argument", () => {
    expect(found(`import(target + '.js');`)).toEqual(["target"]);
  });

  it("DOES find a reference inside a template literal expression", () => {
    expect(found("const s = `value: ${target}`;")).toEqual(["target"]);
  });

  it("handles a realistic zod-shaped module: two names, one shadowed lazily, one used freely", () => {
    const source = `
      import { globalConfig } from "./core.js";
      export function isJitless() {
        return globalConfig.jitless;
      }
      export function withLocalShadow(globalConfig) {
        // parameter shadows the import inside this one function only
        return globalConfig.other;
      }
    `;
    expect(found(source, ["globalConfig"])).toEqual(["globalConfig"]);
  });
});

