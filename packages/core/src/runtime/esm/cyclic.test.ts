import { describe, expect, it } from "vitest";
import { createTestLoader } from "../testing";
import { parseModule } from "./ast";
import { CYCLE_EXPORTS_BRIDGE, rewriteCyclicModule } from "./cyclic";

const acorn = createTestLoader().require("internal/deps/acorn/acorn/dist/acorn");

const rewrite = (
  source: string,
  cycleKeys: Map<string, string> | Set<string>,
  selfKey: string,
  resolveExternal: (s: string) => string = (s) => `blob:${s}`,
) => {
  // A Set is shorthand for "this specifier's own text IS its resolved key" (fine for tests that
  // never cross-check against a DIFFERENT module's own self-key); the real-execution tests below
  // need genuine resolution (a relative specifier like "./util.js" must resolve to the SAME
  // absolute key util.js registers itself under, "/util.js" - a real resolver's whole job).
  const resolved = cycleKeys instanceof Map ? cycleKeys : new Map([...cycleKeys].map((k) => [k, k]));
  return rewriteCyclicModule(
    source,
    parseModule(acorn, source, selfKey),
    (specifierText) => resolved.get(specifierText),
    resolveExternal,
    selfKey,
    acorn,
  );
};

describe("rewriteCyclicModule - shape", () => {
  it("removes a cyclic import and reads its bindings live off a bridge call, keeping non-cyclic imports untouched", () => {
    const source = `import { a, b as c } from './sibling.js';\nimport { d } from './external.js';\nexport const sum = a + c + d;\n`;
    const out = rewrite(source, new Set(["./sibling.js"]), "/self.mjs");
    expect(out).toContain(`const __wcvm_cyc_0__ = ${CYCLE_EXPORTS_BRIDGE}("./sibling.js");`);
    expect(out).toContain(`import { d } from "blob:./external.js";`);
    expect(out).toContain(`__wcvm_cyc_0__["a"] + __wcvm_cyc_0__["b"] + d`);
    expect(out).not.toContain("./sibling.js';");
  });

  it("installs a getter-backed registry for its own exports at the end, closing over the real local bindings", () => {
    const source = `export const x = 1;\nexport function f() { return 2; }\n`;
    const out = rewrite(source, new Set(), "/self.mjs");
    expect(out).toContain(`Object.defineProperties(${CYCLE_EXPORTS_BRIDGE}("/self.mjs"), {`);
    expect(out).toContain(`["x"]: { get() { return x; }, enumerable: true },`);
    expect(out).toContain(`["f"]: { get() { return f; }, enumerable: true },`);
  });

  it("rewrites a namespace import to the whole bridge object directly (no property indirection)", () => {
    const source = `import * as ns from './sibling.js';\nexport const y = ns.thing;\n`;
    const out = rewrite(source, new Set(["./sibling.js"]), "/self.mjs");
    expect(out).toContain(`__wcvm_cyc_0__.thing`);
  });

  it("rewrites a default import to a property read", () => {
    const source = `import Foo from './sibling.js';\nexport const y = Foo();\n`;
    const out = rewrite(source, new Set(["./sibling.js"]), "/self.mjs");
    expect(out).toContain(`__wcvm_cyc_0__["default"]()`);
  });

  it("does not touch a reference shadowed by a nested scope", () => {
    const source = `import { a } from './sibling.js';\nexport function f(a) { return a; }\nexport const outer = a;\n`;
    const out = rewrite(source, new Set(["./sibling.js"]), "/self.mjs");
    expect(out).toContain(`function f(a) { return a; }`); // untouched inside its own scope
    expect(out).toContain(`const outer = __wcvm_cyc_0__["a"];`);
  });

  it("a local re-export of a cyclic-imported name (export { a, b } with no source) is dropped and re-exported via the registry getter instead - real @tanstack/router-core shape", () => {
    // isServer/server.js's own real shape: imports a cyclic name, then re-exports it BARE
    // alongside a genuinely local const in the SAME statement - a real SyntaxError otherwise
    // ("Export 'loadServerRoute' is not defined in module"), since the import that used to
    // declare it is gone.
    const source = `import { loadServerRoute } from './load-server.js';\nconst isServer = true;\nexport { isServer, loadServerRoute };\n`;
    const out = rewrite(source, new Set(["./load-server.js"]), "/isServer/server.js");
    expect(out).not.toMatch(/export\s*\{/); // the whole statement is gone, not patched in place
    expect(out).toContain(`["isServer"]: { get() { return isServer; }, enumerable: true },`);
    expect(out).toContain(`["loadServerRoute"]: { get() { return __wcvm_cyc_0__["loadServerRoute"]; }, enumerable: true },`);
  });

  it("a default export that's just a bare identifier re-exports live too, if that identifier is a cyclic import", () => {
    const source = `import { thing } from './sibling.js';\nexport default thing;\n`;
    const out = rewrite(source, new Set(["./sibling.js"]), "/self.mjs");
    expect(out).toContain(`["default"]: { get() { return __wcvm_cyc_0__["thing"]; }, enumerable: true },`);
  });

  it("rewrites a non-identifier default export under a fresh local name", () => {
    const source = `export default 42;\n`;
    const out = rewrite(source, new Set(), "/self.mjs");
    expect(out).toMatch(/const __wcvm_default_export_\d+__ = 42;/);
    expect(out).toMatch(/\["default"\]: \{ get\(\) \{ return __wcvm_default_export_\d+__; \}, enumerable: true \}/);
  });

  it("dedupes multiple imports of the same cyclic sibling to one bridge call", () => {
    const source = `import { a } from './sibling.js';\nimport { b } from './sibling.js';\nexport const s = a + b;\n`;
    const out = rewrite(source, new Set(["./sibling.js"]), "/self.mjs");
    expect(out.match(new RegExp(CYCLE_EXPORTS_BRIDGE, "g"))).toHaveLength(2); // one for the import, one for self-registration
  });

  it("still throws the clear, unsupported error for a re-export closing a cycle", () => {
    expect(() => rewrite(`export { a } from './sibling.js';`, new Set(["./sibling.js"]), "/self.mjs")).toThrow(
      /ERR_CIRCULAR_ESM_NOT_SUPPORTED|re-export/,
    );
  });
});

describe("rewriteCyclicModule - real execution (the actual point of all this)", () => {
  /** A minimal, real stand-in for loader.ts's own registry: a plain Map from key to a lazily
   *  created plain object - exactly the part of the real bridge this test needs to prove the
   *  REWRITTEN CODE ITSELF behaves correctly, independent of the real blob/import machinery
   *  (Chromium-only - see this repo's own "Node accepts things browsers reject" testing note). */
  const makeBridge = () => {
    const registries = new Map<string, Record<string, unknown>>();
    const bridge = (key: string) => {
      let registry = registries.get(key);
      if (!registry) {
        registry = {};
        registries.set(key, registry);
      }
      return registry;
    };
    return bridge;
  };

  const runAsFactory = (rewritten: string, bridge: (key: string) => object) => {
    const asFunctionBody = rewritten
      .replaceAll(`${CYCLE_EXPORTS_BRIDGE}(`, `__bridge(`)
      .replace(/^(\s*)export const /gm, "$1var ")
      .replace(/^(\s*)export function /gm, "$1function ");
    return new Function("__bridge", `${asFunctionBody}\nreturn typeof exportsForTest !== "undefined" ? exportsForTest() : undefined;`)(bridge);
  };

  it("a real zod-shaped cycle: one side's lazy usage sees the other's real (not partial) export", () => {
    // core.js: imports util.js's `installMembers`, calls it later (inside a function, not at top
    // level - the exact shape that broke a plain CJS-style snapshot, see cyclic.ts's own doc
    // comment) with its OWN `globalConfig`.
    const coreSource = `
      import { installMembers } from './util.js';
      export const globalConfig = { count: 0 };
      export function setup() { installMembers(globalConfig); }
      function exportsForTest() { return { globalConfig, setup }; }
    `;
    // util.js: imports core.js's `globalConfig`, reads it later too (inside a function).
    const utilSource = `
      import { globalConfig } from './core.js';
      export function installMembers(obj) { obj.installed = true; }
      export function readCount() { return globalConfig.count; }
      function exportsForTest() { return { installMembers, readCount }; }
    `;
    const coreOut = rewrite(coreSource, new Map([["./util.js", "/util.js"]]), "/core.js");
    const utilOut = rewrite(utilSource, new Map([["./core.js", "/core.js"]]), "/util.js");

    const bridge = makeBridge();
    // Order matters for THIS test's own realism: core runs first (matching the real trace this
    // whole design was checked against), same as `main.mjs` importing core.js before util.js.
    const core = runAsFactory(coreOut, bridge);
    const util = runAsFactory(utilOut, bridge);

    core.setup(); // calls util's installMembers(globalConfig) - both real functions, both real
    core.globalConfig.count = 5; // a real mutation, from OUTSIDE either module

    expect(core.globalConfig.installed).toBe(true); // util's side really ran, on the SAME object
    expect(util.readCount()).toBe(5); // util's lazy read sees the REAL, current value - not undefined
  });

  it("still works when util.js's factory runs FIRST instead (order shouldn't matter - neither side reads eagerly)", () => {
    const coreSource = `
      import { installMembers } from './util.js';
      export const globalConfig = { count: 0 };
      export function setup() { installMembers(globalConfig); }
      function exportsForTest() { return { globalConfig, setup }; }
    `;
    const utilSource = `
      import { globalConfig } from './core.js';
      export function installMembers(obj) { obj.installed = true; }
      export function readCount() { return globalConfig.count; }
      function exportsForTest() { return { installMembers, readCount }; }
    `;
    const coreOut = rewrite(coreSource, new Map([["./util.js", "/util.js"]]), "/core.js");
    const utilOut = rewrite(utilSource, new Map([["./core.js", "/core.js"]]), "/util.js");

    const bridge = makeBridge();
    const util = runAsFactory(utilOut, bridge);
    const core = runAsFactory(coreOut, bridge);

    core.setup();
    core.globalConfig.count = 9;

    expect(core.globalConfig.installed).toBe(true);
    expect(util.readCount()).toBe(9);
  });
});
