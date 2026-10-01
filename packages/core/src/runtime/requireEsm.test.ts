import { describe, expect, it } from "vitest";
import type { IChildProcessHost } from "./bindings/childProcess";
import { runScript } from "./harness";

// Synchronous require() of an ES module - real Node 24's `require(esm)`. Every expected output
// below was checked against real Node 24 (`node -e` with the same files on disk).

const noopChildProcessHost: IChildProcessHost = {
  spawn: () => {}, kill: () => {}, writeStdin: () => {}, endStdin: () => {},
  writeIpc: () => {}, endIpc: () => {}, onEvent: () => {},
};

const run = (files: Record<string, string>, main = "/app/main.js") =>
  runScript(files, main, { cwd: "/app", childProcess: noopChildProcessHost });

const ESM_PKG = (name: string, files: Record<string, string>): Record<string, string> => ({
  [`/app/node_modules/${name}/package.json`]: JSON.stringify({ name, type: "module", exports: "./index.js" }),
  ...Object.fromEntries(Object.entries(files).map(([f, c]) => [`/app/node_modules/${name}/${f}`, c])),
});

describe("require(esm)", () => {
  it("loads a .mjs file: named, default and function exports", async () => {
    const r = await run({
      "/app/main.js": `const m = require("./lib.mjs"); console.log(m.a, m.default, m.f(2), Object.keys(m).join(","), m.__esModule);`,
      "/app/lib.mjs": `export const a = 1; export default "dflt"; export function f(x) { return x * 2; }`,
    });
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe("1 dflt 4 a,default,f true\n");
  });

  it("uses package.json \"type\": \"module\" for a .js file and resolves the package's exports", async () => {
    const r = await run({
      "/app/main.js": `const { greet } = require("esm-pkg"); console.log(greet("x"));`,
      ...ESM_PKG("esm-pkg", { "index.js": `export const greet = (n) => "hi " + n;` }),
    });
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe("hi x\n");
  });

  it("detects ESM syntax in a .js file with no package.json \"type\", like Node 24", async () => {
    const r = await run({
      "/app/main.js": `console.log(require("./plain.js").v);`,
      "/app/plain.js": `export const v = "detected";`,
    });
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe("detected\n");
  });

  it("imports keep live bindings across modules", async () => {
    const r = await run({
      "/app/main.js": `const c = require("./counter.mjs"); console.log(c.count); c.inc(); c.inc(); console.log(c.count);`,
      "/app/counter.mjs": `export let count = 0; export function inc() { count++; }`,
    });
    expect(r.stdout).toBe("0\n2\n");
  });

  it("supports import forms: default, named+alias, namespace and side-effect-only", async () => {
    const r = await run({
      "/app/main.js": `require("./a.mjs");`,
      "/app/a.mjs": `import d, { x as y, z } from "./b.mjs"; import * as ns from "./b.mjs"; import "./side.mjs";
console.log(d, y, z, Object.keys(ns).sort().join(","), typeof ns.default);`,
      "/app/b.mjs": `export default "D"; export const x = "X"; export const z = "Z";`,
      "/app/side.mjs": `console.log("side effect");`,
    });
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe("side effect\nD X Z default,x,z string\n");
  });

  it("supports re-exports: named, renamed, star and namespace", async () => {
    const r = await run({
      "/app/main.js": `const m = require("./re.mjs"); console.log(Object.keys(m).sort().join(","), m.one, m.renamed, m.ns.two, m.two);`,
      "/app/re.mjs": `export { one } from "./src.mjs"; export { two as renamed } from "./src.mjs"; export * from "./src.mjs"; export * as ns from "./src.mjs";`,
      "/app/src.mjs": `export const one = 1; export const two = 2; export default "ignored by export *";`,
    });
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe("ns,one,renamed,two 1 2 2 2\n");
  });

  it("handles every export default shape", async () => {
    const r = await run({
      "/app/main.js": `for (const f of ["fn", "cls", "anon", "expr", "ident"]) console.log(f, typeof require("./d-" + f + ".mjs").default);`,
      "/app/d-fn.mjs": `export default function named() {}`,
      "/app/d-cls.mjs": `export default class Named {}`,
      "/app/d-anon.mjs": `export default function () {}`,
      "/app/d-expr.mjs": `import { v } from "./v.mjs"; export default { v }`,
      "/app/d-ident.mjs": `const thing = 5; export default thing;`,
      "/app/v.mjs": `export const v = 1;`,
    });
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe("fn function\ncls function\nanon function\nexpr object\nident number\n");
  });

  it("gives an ESM module CJS default = module.exports and named keys, and builtins likewise", async () => {
    const r = await run({
      "/app/main.js": `require("./use.mjs");`,
      "/app/use.mjs": `import cjs, { named } from "./c.cjs"; import fs, { readFileSync } from "node:fs"; import path from "path";
console.log(cjs.named, named, typeof fs.readFileSync, readFileSync === fs.readFileSync, path.sep);`,
      "/app/c.cjs": `module.exports = { named: "N" };`,
    });
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe("N N function true /\n");
  });

  it("resolves an ESM import with the \"import\" condition, not \"require\"", async () => {
    const r = await run({
      "/app/main.js": `console.log(require("./e.mjs").which, require("dual"));`,
      "/app/e.mjs": `import which from "dual"; export { which };`,
      "/app/node_modules/dual/package.json": JSON.stringify({ name: "dual", exports: { import: "./esm.mjs", require: "./cjs.js" } }),
      "/app/node_modules/dual/esm.mjs": `export default "from-import";`,
      "/app/node_modules/dual/cjs.js": `module.exports = "from-require";`,
    });
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe("from-import from-require\n");
  });

  it("gives a circular import live getters (TDZ only for a top-level read)", async () => {
    const r = await run({
      "/app/main.js": `const a = require("./a.mjs"); console.log(a.fromA(), a.viaB());`,
      "/app/a.mjs": `import { fromB } from "./b.mjs"; export const fromA = () => "A"; export const viaB = () => fromB();`,
      "/app/b.mjs": `import { fromA } from "./a.mjs"; export const fromB = () => "B+" + fromA();`,
    });
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe("A B+A\n");
  });

  // import.meta and import() inside a required ES module go through the bridge globals that only
  // exist on a real worker's `self` (like cjsDynamicImport.test.ts's own note) - see the Chromium
  // e2e test "require(esm)" in examples/playground/e2e/boot.spec.ts.

  it("lets a module declare names the wrapper uses internally (__dirname, exports, process, setTimeout)", async () => {
    const r = await run({
      "/app/main.js": `const m = require("./names.mjs"); console.log(m.out, typeof __dirname);`,
      "/app/names.mjs": `import { fileURLToPath } from "node:url";
const __dirname = "own-dirname"; const __filename = "own-filename"; const exports = { own: 1 };
function setTimeout() { return "own-timer"; } class Buffer {}
export const out = [__dirname, __filename, exports.own, setTimeout(), typeof Buffer, typeof fileURLToPath].join(",");`,
    });
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe("own-dirname,own-filename,1,own-timer,function,function string\n");
  });

  it("rewrites imported bindings used in parameter defaults, destructuring defaults and class fields", async () => {
    const r = await run({
      "/app/main.js": `const m = require("./u.mjs"); console.log(m.f(), m.g({}), m.h(), new m.K().v, m.arrow());`,
      "/app/u.mjs": `import { val } from "./v.mjs";
export function f(x = val()) { return x; }
export function g({ a = val() }) { return a; }
export const h = (y = val(), { z = val() } = {}) => y + z;
export class K { v = val(); }
export const arrow = (q = () => val()) => q();`,
      "/app/v.mjs": `export const val = () => "v";`,
    });
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe("v v vv v v\n");
  });

  it("handles `export default <imported name>` (cli-spinners) and JSON imports with attributes", async () => {
    const r = await run({
      "/app/main.js": `const m = require("./d.mjs"); console.log(m.default.a, m.other());`,
      "/app/d.mjs": `import spinners from "./s.json" with { type: "json" };
export default spinners;
export function other() { return Object.keys(spinners).length; }`,
      "/app/s.json": `{"a": 1, "b": 2}`,
    });
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe("1 2\n");
  });

  it("throws ERR_REQUIRE_ASYNC_MODULE for top-level await, like Node", async () => {
    const r = await run({
      "/app/main.js": `try { require("./tla.mjs"); } catch (e) { console.log(e.code); }`,
      "/app/tla.mjs": `await Promise.resolve(); export const x = 1;`,
    });
    expect(r.stdout).toBe("ERR_REQUIRE_ASYNC_MODULE\n");
  });

  it("does not run a module twice when a dependency it requires has a SyntaxError", async () => {
    const r = await run({
      "/app/main.js": `try { require("./outer.js"); } catch (e) { console.log(e.constructor.name); }`,
      "/app/outer.js": `console.log("outer ran"); require("./broken.js");`,
      "/app/broken.js": `this is not javascript`,
    });
    expect(r.stdout).toBe("outer ran\nSyntaxError\n");
  });
});
