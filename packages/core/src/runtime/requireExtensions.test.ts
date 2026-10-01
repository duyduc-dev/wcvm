import { describe, expect, it } from "vitest";
import type { IChildProcessHost } from "./bindings/childProcess";
import { runScript } from "./harness";

// `require.extensions` / `Module._extensions` - the table transpiler hooks (ts-node, @babel/register,
// esbuild-register, Next's next.config.ts loader) have always registered into. It used to be absent
// (`require.extensions['.js']` -> "Cannot read properties of undefined"), which ended `next dev`.

const noopChildProcessHost: IChildProcessHost = {
  spawn: () => {}, kill: () => {}, writeStdin: () => {}, endStdin: () => {},
  writeIpc: () => {}, endIpc: () => {}, onEvent: () => {},
};
const run = (source: string, files: Record<string, string> = {}) =>
  runScript({ ...files, "/app/main.js": source }, "/app/main.js", { cwd: "/app", childProcess: noopChildProcessHost });

describe("require.extensions", () => {
  it("is Module._extensions, with the three handlers real Node has", async () => {
    const r = await run(`
      const Module = require("module");
      console.log(require.extensions === Module._extensions, Object.keys(require.extensions).join(","));
      console.log(typeof require.extensions[".js"], typeof require.extensions[".json"], typeof require.extensions[".node"]);
    `);
    expect(r).toEqual(expect.objectContaining({ code: 0, stdout: "true .js,.json,.node\nfunction function function\n" }));
  });

  it("loads a file with a newly registered extension through its handler, including an extensionless request", async () => {
    const r = await run(`
      require.extensions[".txt"] = (module, filename) => {
        module.exports = "txt:" + require("fs").readFileSync(filename, "utf8").trim();
      };
      console.log(require("./a.txt"));
      console.log(require("./b")); // no extension: resolved through the registered ones
    `, { "/app/a.txt": "hello\n", "/app/b.txt": "world\n" });
    expect(r).toEqual(expect.objectContaining({ code: 0, stdout: "txt:hello\ntxt:world\n" }));
  });

  it("lets a hook wrap `.js` and `_compile` to transform source first (what next.config.ts loading does)", async () => {
    const r = await run(`
      const original = require.extensions[".js"];
      require.extensions[".js"] = function (module, filename) {
        if (!filename.endsWith("/mod.js")) return original(module, filename);
        const compile = module._compile;
        module._compile = function (code, name) { return compile.call(this, code.replace("__PLACEHOLDER__", "'transformed'"), name); };
        return original(module, filename);
      };
      console.log(require("./mod").value, require("./other").value);
    `, { "/app/mod.js": "exports.value = __PLACEHOLDER__;", "/app/other.js": "exports.value = 'untouched';" });
    expect(r).toEqual(expect.objectContaining({ code: 0, stdout: "transformed untouched\n" }));
  });

  it("uses the longest registered extension for the handler", async () => {
    const r = await run(`
      require.extensions[".js"] = require.extensions[".js"];
      require.extensions[".spec.js"] = (module) => { module.exports = "spec-handler"; };
      console.log(require("./x.spec.js"), require("./y.js"));
    `, { "/app/x.spec.js": "module.exports = 'plain';", "/app/y.js": "module.exports = 'plain y';" });
    expect(r).toEqual(expect.objectContaining({ code: 0, stdout: "spec-handler plain y\n" }));
  });

  it("a .node file fails with a clear dlopen error instead of being run as JavaScript", async () => {
    const r = await run(`
      try { require("./addon.node"); } catch (e) { console.log(e.code); }
    `, { "/app/addon.node": "not really native" });
    expect(r).toEqual(expect.objectContaining({ code: 0, stdout: "ERR_DLOPEN_FAILED\n" }));
  });

  it("still loads .json, plain CommonJS and ES modules the way it did", async () => {
    const r = await run(`
      console.log(require("./d.json").n, require("./c").v, require("./e.mjs").v);
    `, { "/app/d.json": '{"n": 1}', "/app/c.js": "exports.v = 2;", "/app/e.mjs": "export const v = 3;" });
    expect(r).toEqual(expect.objectContaining({ code: 0, stdout: "1 2 3\n" }));
  });
});
