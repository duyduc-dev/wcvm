import { beforeEach, describe, expect, it } from "vitest";
import { createLoopbackFs } from "../../testing/loopbackFs";
import type { IFsClient } from "../../fs/fsClient";
import { createEsmResolver, EsmResolveError, IEsmResolver } from "./resolve";

const path = {
  resolve: (...parts: string[]) => {
    const segments: string[] = [];
    for (const part of parts) {
      const abs = part.startsWith("/");
      if (abs) segments.length = 0;
      for (const seg of part.split("/")) {
        if (seg === "" || seg === ".") continue;
        if (seg === "..") segments.pop();
        else segments.push(seg);
      }
    }
    return `/${segments.join("/")}`;
  },
  dirname: (p: string) => p.slice(0, p.lastIndexOf("/")) || "/",
};

const builtins = { canBeRequiredByUsers: (id: string) => id === "fs" || id === "path" };

let fs: IFsClient;
let resolver: IEsmResolver;
beforeEach(() => {
  fs = createLoopbackFs().fs;
  resolver = createEsmResolver({ fs, path, builtins });
});

describe("node builtins", () => {
  it("resolves a node: specifier and a bare builtin name the same way", () => {
    expect(resolver.resolveEsmSpecifier("node:fs", "/app")).toEqual({ format: "builtin", key: "fs" });
    expect(resolver.resolveEsmSpecifier("fs", "/app")).toEqual({ format: "builtin", key: "fs" });
  });

  it("rejects an unknown node: builtin", () => {
    expect(() => resolver.resolveEsmSpecifier("node:not-a-real-module", "/app")).toThrow(EsmResolveError);
  });
});

describe("relative specifiers", () => {
  it("resolves .mjs/.cjs/.json/.js by extension, .js by the nearest package.json type", () => {
    fs.mkdir("/app", { recursive: true });
    fs.writeFile("/app/a.mjs", "");
    fs.writeFile("/app/b.cjs", "");
    fs.writeFile("/app/c.json", "{}");
    fs.writeFile("/app/d.js", "");
    fs.writeFile("/app/package.json", `{"type":"module"}`);

    expect(resolver.resolveEsmSpecifier("./a.mjs", "/app")).toEqual({ format: "esm", key: "/app/a.mjs" });
    expect(resolver.resolveEsmSpecifier("./b.cjs", "/app")).toEqual({ format: "cjs", key: "/app/b.cjs" });
    expect(resolver.resolveEsmSpecifier("./c.json", "/app")).toEqual({ format: "json", key: "/app/c.json" });
    expect(resolver.resolveEsmSpecifier("./d.js", "/app")).toEqual({ format: "esm", key: "/app/d.js" });
  });

  it("a .js file defaults to cjs when no package.json says type: module", () => {
    fs.mkdir("/plain", { recursive: true });
    fs.writeFile("/plain/x.js", "");
    expect(resolver.resolveEsmSpecifier("./x.js", "/plain")).toEqual({ format: "cjs", key: "/plain/x.js" });
  });

  it("walks up to the nearest package.json, not just the immediate directory", () => {
    fs.mkdir("/proj/src", { recursive: true });
    fs.writeFile("/proj/package.json", `{"type":"module"}`);
    fs.writeFile("/proj/src/y.js", "");
    expect(resolver.resolveEsmSpecifier("./y.js", "/proj/src")).toEqual({ format: "esm", key: "/proj/src/y.js" });
  });

  it("does not guess extensions or fall back to a directory index", () => {
    fs.mkdir("/app/dir", { recursive: true });
    fs.writeFile("/app/dir/index.js", "");
    expect(() => resolver.resolveEsmSpecifier("./missing", "/app")).toThrow(/ERR_MODULE_NOT_FOUND|explicit file extension/);
    expect(() => resolver.resolveEsmSpecifier("./dir", "/app")).toThrow(EsmResolveError);
  });
});

describe("bare package specifiers", () => {
  it("resolves via package.json exports, honouring the import condition", () => {
    fs.mkdir("/app/node_modules/pkg", { recursive: true });
    fs.writeFile("/app/node_modules/pkg/package.json", `{"exports":{".":{"import":"./esm.js","require":"./cjs.js"}}}`);
    fs.writeFile("/app/node_modules/pkg/esm.js", "");
    expect(resolver.resolveEsmSpecifier("pkg", "/app")).toEqual({ format: "cjs", key: "/app/node_modules/pkg/esm.js" });
  });

  it("resolves a subpath export and a * pattern", () => {
    fs.mkdir("/app/node_modules/pkg/lib", { recursive: true });
    fs.writeFile("/app/node_modules/pkg/package.json", `{"exports":{"./util":"./lib/util.js","./features/*":"./lib/*.js"}}`);
    fs.writeFile("/app/node_modules/pkg/lib/util.js", "");
    fs.writeFile("/app/node_modules/pkg/lib/thing.js", "");
    expect(resolver.resolveEsmSpecifier("pkg/util", "/app")).toMatchObject({ key: "/app/node_modules/pkg/lib/util.js" });
    expect(resolver.resolveEsmSpecifier("pkg/features/thing", "/app")).toMatchObject({ key: "/app/node_modules/pkg/lib/thing.js" });
  });

  it("falls back to main/index.js when a package has no exports field", () => {
    fs.mkdir("/app/node_modules/legacy", { recursive: true });
    fs.writeFile("/app/node_modules/legacy/package.json", `{"main":"start.js"}`);
    fs.writeFile("/app/node_modules/legacy/start.js", "");
    expect(resolver.resolveEsmSpecifier("legacy", "/app")).toMatchObject({ key: "/app/node_modules/legacy/start.js" });
  });

  it("rejects a subpath not defined in exports, and a missing package", () => {
    fs.mkdir("/app/node_modules/pkg", { recursive: true });
    fs.writeFile("/app/node_modules/pkg/package.json", `{"exports":{".":"./index.js"}}`);
    fs.writeFile("/app/node_modules/pkg/index.js", "");
    expect(() => resolver.resolveEsmSpecifier("pkg/nope", "/app")).toThrow(/not defined/);
    expect(() => resolver.resolveEsmSpecifier("nope-at-all", "/app")).toThrow(/Cannot find package/);
  });

  it("walks up through node_modules directories toward the root", () => {
    fs.mkdir("/a/b/node_modules", { recursive: true });
    fs.mkdir("/a/node_modules/pkg", { recursive: true });
    fs.writeFile("/a/node_modules/pkg/package.json", `{"exports":"./main.js"}`);
    fs.writeFile("/a/node_modules/pkg/main.js", "");
    expect(resolver.resolveEsmSpecifier("pkg", "/a/b")).toMatchObject({ key: "/a/node_modules/pkg/main.js" });
  });

  describe('package.json "imports" (#specifiers)', () => {
    const files = {
      "/app/node_modules/vite/package.json": JSON.stringify({
        name: "vite",
        type: "module",
        imports: {
          // Vite's own: only true where require(esm) exists, which it doesn't here.
          "#module-sync-enabled": { "module-sync": "./misc/true.js", default: "./misc/false.js" },
          "#internal/*": "./dist/internal/*.js",
          "#dep": "dep-pkg",
          "#fs": "fs",
          "#bad": "../outside.js",
        },
      }),
      "/app/node_modules/vite/misc/true.js": "",
      "/app/node_modules/vite/misc/false.js": "",
      "/app/node_modules/vite/dist/internal/util.js": "",
      "/app/node_modules/vite/dist/node/chunks/config.js": "",
      "/app/node_modules/dep-pkg/package.json": JSON.stringify({ name: "dep-pkg", main: "main.cjs" }),
      "/app/node_modules/dep-pkg/main.cjs": "",
    };
    const from = "/app/node_modules/vite/dist/node/chunks";
    const setup = (tree: Record<string, string>) => {
      for (const [file, contents] of Object.entries(tree)) {
        fs.mkdir(path.dirname(file), { recursive: true });
        fs.writeFile(file, contents);
      }
      return resolver;
    };

    it("maps an exact key through its conditions, from anywhere inside the package", () => {
      expect(setup(files).resolveEsmSpecifier("#module-sync-enabled", from)).toEqual({ format: "esm", key: "/app/node_modules/vite/misc/false.js" });
    });

    it("maps a * pattern", () => {
      expect(setup(files).resolveEsmSpecifier("#internal/util", from)).toEqual({ format: "esm", key: "/app/node_modules/vite/dist/internal/util.js" });
    });

    it("lets a target name another package, or a builtin - unlike an \"exports\" target", () => {
      const r = setup(files);
      expect(r.resolveEsmSpecifier("#dep", from)).toEqual({ format: "cjs", key: "/app/node_modules/dep-pkg/main.cjs" });
      expect(r.resolveEsmSpecifier("#fs", from)).toEqual({ format: "builtin", key: "fs" });
    });

    it("rejects an undefined import and a target escaping the package, with Node's codes", () => {
      const r = setup(files);
      expect(() => r.resolveEsmSpecifier("#nope", from)).toThrow(expect.objectContaining({ code: "ERR_PACKAGE_IMPORT_NOT_DEFINED" }));
      expect(() => r.resolveEsmSpecifier("#bad", from)).toThrow(expect.objectContaining({ code: "ERR_INVALID_PACKAGE_TARGET" }));
      expect(() => r.resolveEsmSpecifier("#/x", from)).toThrow(expect.objectContaining({ code: "ERR_PACKAGE_IMPORT_NOT_DEFINED" }));
    });
  });
});

