import { describe, expect, it } from "vitest";
import { createTestLoader } from "../testing";
import { parseModule, type AnyNode } from "./ast";
import { namedReexports } from "./loader";

const acorn = createTestLoader().require("internal/deps/acorn/acorn/dist/acorn");

describe("namedReexports", () => {
  it("emits one `export const` per enumerable key", () => {
    const out = namedReexports("__m", { a: 1, b: 2 });
    expect(out).toContain(`export const a = __read("a");`);
    expect(out).toContain(`export const b = __read("b");`);
  });

  it("skips a `default` key and any non-identifier-shaped key", () => {
    const out = namedReexports("__m", { default: 1, "not-an-identifier": 2, ok: 3 });
    expect(out).not.toContain('"default"');
    expect(out).not.toContain("not-an-identifier");
    expect(out).toContain(`export const ok = __read("ok");`);
  });

  it("returns an empty string when there's nothing to export", () => {
    expect(namedReexports("__m", {})).toBe("");
    expect(namedReexports("__m", null)).toBe("");
    expect(namedReexports("__m", 5)).toBe("");
  });

  // Real bug, hit for real: @babel/types exports a property literally named "import" (its AST
  // builder for the `Import` node type, e.g. `t.import(...)`), reached transitively through
  // solid-refresh/babel -> @babel/generator -> @babel/types. A bare `export const import = ...`
  // is a syntax error (reserved word as a binding identifier) even though `import` is a
  // perfectly valid EXPORTED name - it broke Solid's entire dev server with a bare "SyntaxError:
  // Unexpected token 'import'", no stack, no indication of which module, since the invalid
  // syntax lived in this synthesized shim rather than in any real file on disk.
  it("emits a reserved-word key as an aliased export, not a bare `export const`, and the result is valid JS", () => {
    const out = namedReexports("__m", { import: 1, class: 2, ok: 3 });
    expect(out).not.toContain("export const import");
    expect(out).not.toContain("export const class");
    expect(out).toContain(`export { __reserved_export_0 as import };`);
    expect(out).toContain(`export { __reserved_export_1 as class };`);
    expect(out).toContain(`export const ok = __read("ok");`);
    // The whole point: this must actually PARSE as valid ESM.
    expect(() => parseModule(acorn, out, "/test.mjs")).not.toThrow();
  });

  it("round-trips a reserved-word export through a real import specifier alias", () => {
    const out = namedReexports("__m", { import: 42 });
    const full = `const __m = { import: 42 };\n${out}`;
    const ast = parseModule(acorn, full, "/test.mjs");
    const body = ast.body as AnyNode[];
    expect(body.some((n) => n.type === "ExportNamedDeclaration")).toBe(true);
  });
});
