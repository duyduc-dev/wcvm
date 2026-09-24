import { describe, expect, it } from "vitest";
import { createTestLoader } from "../testing";
import { dynamicImportCalls, EsmSyntaxError, parseModule, parseScript, staticImportSpecifiers } from "./ast";
import { DYNAMIC_IMPORT_BRIDGE, rewriteModule } from "./rewrite";

const acorn = createTestLoader().require("internal/deps/acorn/acorn/dist/acorn");
const parse = (source: string) => parseModule(acorn, source, "/test.mjs");

describe("parseModule", () => {
  it("parses real ESM syntax via Node's own vendored acorn", () => {
    const ast = parse("export const x = 1;");
    expect(ast.type).toBe("Program");
  });

  it("wraps a syntax error with the filename", () => {
    expect(() => parse("export const =")).toThrow(EsmSyntaxError);
    expect(() => parse("export const =")).toThrow(/test\.mjs/);
  });
});

describe("staticImportSpecifiers", () => {
  it("finds import, export-from and export-* specifiers, with exact source positions", () => {
    const source = `import a from './x.js';\nexport { b } from './y.js';\nexport * from './z.js';\n`;
    const specifiers = staticImportSpecifiers(parse(source), source);
    expect(specifiers.map((s) => s.value)).toEqual(["./x.js", "./y.js", "./z.js"]);
    for (const s of specifiers) expect(source.slice(s.start, s.end)).toBe(`'${s.value}'`);
  });

  it("ignores export declarations with no source", () => {
    const source = "export const x = 1; export { x as y };";
    expect(staticImportSpecifiers(parse(source), source)).toEqual([]);
  });

  it("does not see a dynamic import() as a static specifier", () => {
    const source = `const m = import('./x.js');`;
    expect(staticImportSpecifiers(parse(source), source)).toEqual([]);
  });

  it("extends the replaced span through a trailing import-attributes clause, but not the semicolon", () => {
    const source = `import data from './x.json' with { type: 'json' };\n`;
    const [spec] = staticImportSpecifiers(parse(source), source);
    expect(source.slice(spec.start, spec.end)).toBe(`'./x.json' with { type: 'json' }`);
  });

  it("has no attributes clause to strip when there is none, semicolon included", () => {
    const source = `import a from './x.js';\n`;
    const [spec] = staticImportSpecifiers(parse(source), source);
    expect(source.slice(spec.start, spec.end)).toBe(`'./x.js'`);
  });
});

describe("dynamicImportCalls", () => {
  it("finds a dynamic import() anywhere in the tree, including nested in a function", () => {
    const source = `async function f() {\n  const m = await import('./x.js');\n  return m;\n}\n`;
    const calls = dynamicImportCalls(parse(source));
    expect(calls).toHaveLength(1);
    expect(source.slice(calls[0].start, calls[0].end)).toBe(`import('./x.js')`);
    expect(source.slice(calls[0].argStart, calls[0].argEnd)).toBe(`'./x.js'`);
  });

  it("captures a computed (non-literal) argument's own source verbatim", () => {
    const source = `import(dir + '/x.js')`;
    const calls = dynamicImportCalls(parse(source));
    expect(source.slice(calls[0].argStart, calls[0].argEnd)).toBe(`dir + '/x.js'`);
  });

  it("finds every call when there is more than one", () => {
    const source = `import('./a.js'); function f() { import('./b.js'); }`;
    expect(dynamicImportCalls(parse(source))).toHaveLength(2);
  });

  it("does not confuse a static import for a dynamic one", () => {
    expect(dynamicImportCalls(parse(`import a from './x.js';`))).toEqual([]);
  });
});

describe("parseScript (CommonJS / node -e source)", () => {
  it("accepts what the CJS wrapper makes legal: a top-level return and a #! line", () => {
    expect(parseScript(acorn, "#!/usr/bin/env node\nif (x) return;\nmodule.exports = 1;", "/cli.js").type).toBe("Program");
  });

  it("rejects module-only syntax, with the filename", () => {
    expect(() => parseScript(acorn, "import x from 'y';", "/a.js")).toThrow(/a\.js/);
  });

  it("finds a script's import() calls, which rewrite to the same bridge an ES module's use", () => {
    const source = `const load = () => import("./esm.mjs");\nimport(name).then(use);\n// import("in a comment") is not a call\n`;
    const program = parseScript(acorn, source, "/pkg/index.js");
    expect(dynamicImportCalls(program)).toHaveLength(2);
    const rewritten = rewriteModule(source, program, () => "unused", "/pkg/index.js");
    expect(rewritten).toBe(
      `const load = () => ${DYNAMIC_IMPORT_BRIDGE}("./esm.mjs", "/pkg/index.js");\n${DYNAMIC_IMPORT_BRIDGE}(name, "/pkg/index.js").then(use);\n// import("in a comment") is not a call\n`,
    );
  });
});

