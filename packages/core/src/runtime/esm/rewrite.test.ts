import { describe, expect, it } from "vitest";
import { createTestLoader } from "../testing";
import { parseModule } from "./ast";
import { DYNAMIC_IMPORT_BRIDGE, IMPORT_META_BRIDGE, rewriteModule } from "./rewrite";

const acorn = createTestLoader().require("internal/deps/acorn/acorn/dist/acorn");
const rewrite = (source: string, resolveStatic: (s: string) => string = (s) => `blob:${s}`, selfUrl = "/self.mjs", withAcorn = false) =>
  rewriteModule(source, parseModule(acorn, source, "/test.mjs"), resolveStatic, selfUrl, withAcorn ? acorn : undefined);

describe("rewriteModule", () => {
  it("replaces a static import specifier with the resolved URL, leaving the rest of the statement intact", () => {
    const out = rewrite(`import a, { b } from './x.js';`);
    expect(out).toBe(`import a, { b } from "blob:./x.js";`);
  });

  it("replaces export-from and export-* specifiers", () => {
    expect(rewrite(`export { a } from './x.js';`)).toBe(`export { a } from "blob:./x.js";`);
    expect(rewrite(`export * from './x.js';`)).toBe(`export * from "blob:./x.js";`);
  });

  it("does not touch a plain export with no source", () => {
    expect(rewrite(`export const x = 1;`)).toBe(`export const x = 1;`);
  });

  it("rewrites a dynamic import() call to the bridge, passing this module's own URL", () => {
    const out = rewrite(`const m = import('./x.js');`, undefined, "/pkg/self.mjs");
    expect(out).toBe(`const m = ${DYNAMIC_IMPORT_BRIDGE}('./x.js', "/pkg/self.mjs");`);
  });

  it("preserves a computed dynamic import argument verbatim", () => {
    const out = rewrite(`import(dir + '/x.js')`);
    expect(out).toBe(`${DYNAMIC_IMPORT_BRIDGE}(dir + '/x.js', "/self.mjs")`);
  });

  it("handles a module with both static and dynamic imports, and several of each", () => {
    const source = `import a from './a.js';\nimport('./b.js');\nexport { c } from './c.js';\n`;
    const out = rewrite(source, (s) => `URL(${s})`);
    expect(out).toBe(`import a from "URL(./a.js)";\n${DYNAMIC_IMPORT_BRIDGE}('./b.js', "/self.mjs");\nexport { c } from "URL(./c.js)";\n`);
  });

  it("leaves a module with no imports at all unchanged", () => {
    expect(rewrite(`console.log(1);`)).toBe(`console.log(1);`);
  });

  it("rewrites every import.meta to the module's own meta object", () => {
    const source = `const here = import.meta.url;\nconst dir = import.meta.dirname, { url } = import.meta;\n`;
    expect(rewrite(source, undefined, "/src/entry.mjs")).toBe(
      `const here = ${IMPORT_META_BRIDGE}("/src/entry.mjs").url;\n` +
        `const dir = ${IMPORT_META_BRIDGE}("/src/entry.mjs").dirname, { url } = ${IMPORT_META_BRIDGE}("/src/entry.mjs");\n`,
    );
  });

  it("rewrites an import.meta INSIDE a dynamic import's argument too, without the two edits colliding", () => {
    const source = `await import(new URL("./x.mjs", import.meta.url).href, { with: {} });`;
    expect(rewrite(source, undefined, "/src/entry.mjs")).toBe(
      `await ${DYNAMIC_IMPORT_BRIDGE}(new URL("./x.mjs", ${IMPORT_META_BRIDGE}("/src/entry.mjs").url).href, "/src/entry.mjs");`,
    );
  });

  it("rewrites @preact/preset-vite's own `new Function(...)` native-dynamic-import idiom, when acorn is passed", () => {
    const source = `const importEsm = new Function("specifier", "return import(specifier)");`;
    const out = rewrite(source, undefined, "/pkg/transform-hook-names.mjs", true);
    expect(out).toBe(`const importEsm = ((specifier) => ${DYNAMIC_IMPORT_BRIDGE}(specifier, "/pkg/transform-hook-names.mjs"));`);
  });

  it("does the same for a bare `Function(...)` call (no `new`)", () => {
    const source = `const f = Function("s", "return import(s)");`;
    const out = rewrite(source, undefined, "/pkg/x.mjs", true);
    expect(out).toBe(`const f = ((s) => ${DYNAMIC_IMPORT_BRIDGE}(s, "/pkg/x.mjs"));`);
  });

  it("leaves `new Function(...)` untouched when acorn isn't passed (no regression for existing callers)", () => {
    const source = `const importEsm = new Function("specifier", "return import(specifier)");`;
    expect(rewrite(source, undefined, "/pkg/x.mjs", false)).toBe(source);
  });

  it("leaves an UNRELATED `new Function(...)` call untouched (no dynamic import inside its body)", () => {
    const source = `const add = new Function("a", "b", "return a + b");`;
    expect(rewrite(source, undefined, "/pkg/x.mjs", true)).toBe(source);
  });

  it("leaves `new Function(...)` untouched when the body imports something OTHER than a declared parameter", () => {
    const source = `const f = new Function("x", "return import('some-literal-specifier')");`;
    expect(rewrite(source, undefined, "/pkg/x.mjs", true)).toBe(source);
  });

  it("leaves `new Function(...)` untouched when a non-string argument is present", () => {
    const source = `const f = new Function(someVar, "return import(someVar)");`;
    expect(rewrite(source, undefined, "/pkg/x.mjs", true)).toBe(source);
  });
});

