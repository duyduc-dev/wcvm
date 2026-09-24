import { describe, expect, it } from "vitest";
import { createLoopbackFs } from "../testing/loopbackFs";
import { createModuleSystem } from "./cjs";
import { parseScript } from "./esm/ast";
import { DYNAMIC_IMPORT_BRIDGE, rewriteModule } from "./esm/rewrite";
import { createTestLoader } from "./testing";
import nodePath from "node:path";

// The CommonJS half of `import()` from CJS/`node -e` code: cjs.ts hands a module's source to the
// rewrite hook (in production runtime.ts's, backed by esm/loader.ts's rewriteScript) and the
// rewritten `import()` calls reach the dynamic-import bridge with the right base path. The bridge
// itself - ESM resolution, Blob URLs, the browser's real import() - only exists inside a real
// Worker (where it's a true global on `self`), so that part is covered in Chromium instead.

const acorn = createTestLoader().require("internal/deps/acorn/acorn/dist/acorn");

const setup = (files: Record<string, string>) => {
  const { fs } = createLoopbackFs();
  for (const [path, contents] of Object.entries(files)) {
    fs.mkdir(nodePath.dirname(path), { recursive: true });
    fs.writeFile(path, contents);
  }
  const rewrites: string[] = [];
  const bridgeCalls: Array<[unknown, string]> = [];
  const modules = createModuleSystem({
    fs,
    path: nodePath,
    builtins: { canBeRequiredByUsers: () => false, requireBuiltin: () => undefined },
    process: { cwd: () => "/app" },
    // In a real worker the bridge is a true global; here, module globals are how it's reachable.
    globals: { [DYNAMIC_IMPORT_BRIDGE]: (specifier: unknown, selfPath: string) => bridgeCalls.push([specifier, selfPath]) },
    rewriteDynamicImports: (source, selfPath) => {
      rewrites.push(selfPath);
      return rewriteModule(source, parseScript(acorn, source, selfPath), () => "", selfPath);
    },
  });
  return { modules, rewrites, bridgeCalls };
};

describe("import() from CommonJS", () => {
  it("a module's import() calls reach the bridge, resolving from the module's own file", () => {
    const t = setup({
      "/app/lib/a.js": `module.exports = (name) => [import("./b.mjs"), import(name)];`,
    });
    t.modules.require("/app/lib/a.js")("pkg");
    expect(t.bridgeCalls).toEqual([
      ["./b.mjs", "/app/lib/a.js"],
      ["pkg", "/app/lib/a.js"],
    ]);
  });

  it("`node -e` code resolves its import() from the cwd, like real Node's [eval]", () => {
    const t = setup({});
    t.modules.runEval(`import("esm-only");`);
    expect(t.bridgeCalls).toEqual([["esm-only", "/app/[eval]"]]);
  });

  it("source that can't contain an import() is never handed to the parser", () => {
    const t = setup({ "/app/plain.js": "module.exports = 'importer'; // no call here" });
    expect(t.modules.require("/app/plain.js")).toBe("importer");
    expect(t.rewrites).toEqual([]);
  });

  it("a CLI's #! line and top-level return still work once rewritten", () => {
    const t = setup({ "/app/cli.js": `#!/usr/bin/env node\nmodule.exports = 1;\nif (true) return;\nimport("never");` });
    expect(t.modules.require("/app/cli.js")).toBe(1);
    expect(t.rewrites).toEqual(["/app/cli.js"]);
    expect(t.bridgeCalls).toEqual([]);
  });
});
