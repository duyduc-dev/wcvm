import { describe, expect, it } from "vitest";
import { createTestLoader } from "../testing";
import { parseModule } from "./ast";
import { DYNAMIC_IMPORT_BRIDGE, rewriteModule } from "./rewrite";

const acorn = createTestLoader().require("internal/deps/acorn/acorn/dist/acorn");
const rewrite = (source: string, resolveStatic: (s: string) => string = (s) => `blob:${s}`, selfUrl = "/self.mjs") =>
  rewriteModule(source, parseModule(acorn, source, "/test.mjs"), resolveStatic, selfUrl);

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
});
