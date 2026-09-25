import { describe, expect, it } from "vitest";
import { createLoopbackFs } from "../../testing/loopbackFs";
import { FAKE_REGISTRY, createFakeRegistry, type IFakePackage } from "../../testing/fakeRegistry";
import { createNpm } from "./npm";

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** Runs `npm <args>` in /app against a fake registry of `packages`, on a real Vfs. */
const setup = (packages: Record<string, IFakePackage>, files: Record<string, string> = {}) => {
  const { fs } = createLoopbackFs();
  fs.mkdir("/app", { recursive: true });
  for (const [path, contents] of Object.entries(files)) {
    fs.mkdir(path.slice(0, path.lastIndexOf("/")) || "/", { recursive: true });
    fs.writeFile(path, contents);
  }
  const registry = createFakeRegistry(packages);
  const npm = createNpm({ ...registry.deps, now: () => 0 });
  const run = async (args: string[], env: Record<string, string> = {}) => {
    let stdout = "";
    let stderr = "";
    const code = await npm({
      args,
      cwd: "/app",
      env: { npm_config_registry: FAKE_REGISTRY, ...env },
      fs,
      pid: 1,
      sleep: async () => {},
      stdout: (d) => (stdout += typeof d === "string" ? d : decode(d)),
      stderr: (d) => (stderr += typeof d === "string" ? d : decode(d)),
    });
    return { code, stdout, stderr };
  };
  const read = (path: string) => decode(fs.readFile(path));
  const json = (path: string) => JSON.parse(read(path));
  const versionAt = (dir: string) => json(`${dir}/package.json`).version as string;
  return { fs, run, read, json, versionAt, requests: registry.requests };
};

const pkg = (deps: Record<string, string> = {}, extra: Record<string, unknown> = {}) => JSON.stringify({ name: "app", version: "1.0.0", dependencies: deps, ...extra });

describe("npm install", () => {
  it("installs package.json's dependencies and their dependencies, hoisted flat, files and all", async () => {
    const t = setup(
      {
        left: { versions: { "1.0.0": { dependencies: { shared: "^1.0.0" }, files: { "index.js": "module.exports = 'left';" } } } },
        right: { versions: { "2.1.0": { dependencies: { shared: "^1.2.0" } } } },
        shared: { versions: { "1.0.0": {}, "1.2.5": { files: { "lib/deep/file.js": "deep" } }, "2.0.0": {} } },
      },
      { "/app/package.json": pkg({ left: "^1.0.0" }, { devDependencies: { right: "~2.1.0" } }) },
    );
    const r = await t.run(["install"]);
    expect(r).toEqual({ code: 0, stdout: "\nadded 3 packages in 0ms\n", stderr: "" });
    expect(t.fs.readdir("/app/node_modules").sort()).toEqual(["left", "right", "shared"]);
    expect(t.read("/app/node_modules/left/index.js")).toBe("module.exports = 'left';");
    // One copy satisfies both ^1.0.0 and ^1.2.0: the latest (2.0.0) doesn't, so the best 1.x.
    expect(t.versionAt("/app/node_modules/shared")).toBe("1.2.5");
    expect(t.read("/app/node_modules/shared/lib/deep/file.js")).toBe("deep");
    expect(t.json("/app/package.json")).toEqual(JSON.parse(pkg({ left: "^1.0.0" }, { devDependencies: { right: "~2.1.0" } })));
  });

  it("nests a conflicting version under the package that needs it, where Node's resolution finds it first", async () => {
    const t = setup(
      {
        a: { versions: { "1.0.0": {}, "2.0.0": {} } },
        b: { versions: { "1.0.0": { dependencies: { c: "^1.0.0" } } } },
        c: { versions: { "1.0.0": { dependencies: { a: "^2.0.0" } } } },
      },
      { "/app/package.json": pkg({ a: "^1.0.0", b: "^1.0.0" }) },
    );
    expect((await t.run(["install"])).code).toBe(0);
    expect(t.versionAt("/app/node_modules/a")).toBe("1.0.0");
    expect(t.versionAt("/app/node_modules/c")).toBe("1.0.0"); // hoisted: nothing else named c
    expect(t.versionAt("/app/node_modules/c/node_modules/a")).toBe("2.0.0");
    expect(t.fs.exists("/app/node_modules/b/node_modules")).toBe(false);
  });

  it("`npm install <pkg>` installs it and saves it to package.json the way npm does", async () => {
    const t = setup(
      {
        vite: { versions: { "6.0.0": {}, "7.1.2": {}, "8.0.0-beta.1": {} }, "dist-tags": { latest: "7.1.2", next: "8.0.0-beta.1" } },
        react: { versions: { "18.3.1": {}, "19.0.0": {} } },
        ms: { versions: { "2.0.0": {}, "2.1.3": {}, "3.0.0": {} } },
        semver: { versions: { "7.1.0": {}, "7.8.5": {} } },
        "@scope/tool": { versions: { "1.4.0": {} } },
        "esbuild-wasm": { versions: { "0.25.1": {} } },
      },
      { "/app/package.json": JSON.stringify({ name: "app", dependencies: { react: "^19.0.0" } }) },
    );
    expect((await t.run(["install", "vite", "react@~18.3.0", "@scope/tool@1.4.0", "vitenext@npm:vite@next", "ms@>=2.0.0 <2.2.0", "semver@7"])).code).toBe(0);
    expect((await t.run(["i", "-D", "esbuild@npm:esbuild-wasm@^0.25.0"])).code).toBe(0);
    expect(t.json("/app/package.json")).toEqual({
      name: "app",
      // Checked against real npm 11: `x@7` saves "^7.8.5" (^ fits inside 7), `x@~1.1.0` stays as typed.
      dependencies: { "@scope/tool": "^1.4.0", ms: ">=2.0.0 <2.2.0", react: "~18.3.0", semver: "^7.8.5", vite: "^7.1.2", vitenext: "npm:vite@^8.0.0-beta.1" },
      devDependencies: { esbuild: "npm:esbuild-wasm@^0.25.1" }, // ^0.25.1 fits inside the typed ^0.25.0
    });
    expect(t.versionAt("/app/node_modules/react")).toBe("18.3.1");
    expect(t.versionAt("/app/node_modules/@scope/tool")).toBe("1.4.0");
    expect(t.json("/app/node_modules/vitenext/package.json")).toMatchObject({ name: "vite", version: "8.0.0-beta.1" });
    expect(t.json("/app/node_modules/esbuild/package.json")).toMatchObject({ name: "esbuild-wasm", version: "0.25.1" });
    expect(t.requests).toContain(`${FAKE_REGISTRY}@scope%2Ftool`);
  });

  it("creates package.json when installing a named package into a directory without one", async () => {
    const t = setup({ left: { versions: { "1.0.0": {} } } });
    expect((await t.run(["install", "left"])).code).toBe(0);
    expect(t.json("/app/package.json")).toEqual({ dependencies: { left: "^1.0.0" } });
  });

  it("with no package.json and nothing named, fails like npm does", async () => {
    const t = setup({});
    const r = await t.run(["install"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^npm error code ENOENT\nnpm error Could not read package\.json/);
  });

  it("skips optional native builds and failed optional dependencies, with a warning for the latter", async () => {
    const t = setup(
      {
        tool: { versions: { "1.0.0": { optionalDependencies: { "@tool/linux-x64": "1.0.0", "@tool/wasm32": "1.0.0", missing: "^1.0.0" } } } },
        "@tool/linux-x64": { versions: { "1.0.0": { os: ["linux"], cpu: ["x64"] } } },
        "@tool/wasm32": { versions: { "1.0.0": { cpu: ["wasm32"] } } },
      },
      { "/app/package.json": pkg({ tool: "1.0.0" }) },
    );
    const r = await t.run(["install"]);
    expect(r.code).toBe(0);
    expect(t.fs.readdir("/app/node_modules/@tool")).toEqual(["wasm32"]);
    expect(r.stderr).toMatch(/npm warn skipping optional dependency missing@\^1\.0\.0: .*not found/);
    expect(t.requests.some((url) => url.includes("linux-x64-1.0.0.tgz"))).toBe(false);
  });

  it("installs a required peer dependency, but not an optional one", async () => {
    const t = setup(
      {
        plugin: { versions: { "1.0.0": { peerDependencies: { host: "^2.0.0", extra: "*" }, peerDependenciesMeta: { extra: { optional: true } } } } },
        host: { versions: { "2.4.0": {} } },
        extra: { versions: { "1.0.0": {} } },
      },
      { "/app/package.json": pkg({ plugin: "^1.0.0" }) },
    );
    expect((await t.run(["install"])).code).toBe(0);
    expect(t.fs.readdir("/app/node_modules").sort()).toEqual(["host", "plugin"]);
  });

  it("links bins into node_modules/.bin", async () => {
    const t = setup(
      {
        single: { versions: { "1.0.0": { bin: "./bin/single.js", files: { "bin/single.js": "#!/usr/bin/env node" } } } },
        "@scope/multi": { versions: { "1.0.0": { bin: { one: "bin/one.js", two: "./bin/two.js" }, files: { "bin/one.js": "1", "bin/two.js": "2" } } } },
      },
      { "/app/package.json": pkg({ single: "1", "@scope/multi": "1" }) },
    );
    expect((await t.run(["install"])).code).toBe(0);
    expect(t.fs.readdir("/app/node_modules/.bin").sort()).toEqual(["one", "single", "two"]);
    expect(t.fs.readlink("/app/node_modules/.bin/single")).toBe("../single/bin/single.js");
    expect(t.fs.readlink("/app/node_modules/.bin/one")).toBe("../@scope/multi/bin/one.js");
    expect(t.read("/app/node_modules/.bin/two")).toBe("2");
    expect(t.fs.stat("/app/node_modules/single/bin/single.js").mode & 0o111).not.toBe(0);
  });

  it("a second run is up to date without downloading anything; a changed version is replaced and leftovers pruned", async () => {
    const t = setup(
      { left: { versions: { "1.0.0": {}, "1.1.0": {} } }, gone: { versions: { "1.0.0": {} } } },
      { "/app/package.json": pkg({ left: "1.0.0", gone: "1.0.0" }) },
    );
    expect((await t.run(["install"])).code).toBe(0);
    t.fs.mkdir("/app/node_modules/.vite", { recursive: true }); // a tool's own cache - never pruned

    const before = t.requests.length;
    expect(await t.run(["install"])).toEqual({ code: 0, stdout: "\nup to date in 0ms\n", stderr: "" });
    expect(t.requests.slice(before).some((url) => url.endsWith(".tgz"))).toBe(false);

    t.fs.writeFile("/app/package.json", pkg({ left: "1.1.0" }));
    expect((await t.run(["install"])).stdout).toBe("\nadded 1 package in 0ms\n");
    expect(t.versionAt("/app/node_modules/left")).toBe("1.1.0");
    expect(t.fs.readdir("/app/node_modules").sort()).toEqual([".vite", "left"]);
  });

  it("picks versions like npm: latest if it satisfies, else the highest match, avoiding deprecated ones and prereleases", async () => {
    const t = setup(
      {
        a: { versions: { "1.0.0": {}, "1.5.0": { deprecated: "broken" }, "2.0.0": {} } },
        b: { versions: { "1.0.0": {}, "1.1.0-rc.1": {}, "3.0.0": {} }, "dist-tags": { latest: "1.0.0" } },
      },
      { "/app/package.json": pkg({ a: "^1.0.0", b: "*" }) },
    );
    expect((await t.run(["install"])).code).toBe(0);
    expect(t.versionAt("/app/node_modules/a")).toBe("1.0.0");
    expect(t.versionAt("/app/node_modules/b")).toBe("1.0.0"); // latest satisfies "*", even with 3.0.0 published
  });

  it.each([
    ["an unknown package", { "/app/package.json": pkg({ nope: "^1.0.0" }) }, /npm error code E404/],
    ["no matching version", { "/app/package.json": pkg({ left: "^9.0.0" }) }, /npm error code ETARGET\nnpm error No matching version found for left@\^9\.0\.0/],
    ["a git dependency", { "/app/package.json": pkg({ left: "github:user/left" }) }, /npm error code EUNSUPPORTEDPROTOCOL/],
    ["a tarball failing its integrity check", { "/app/package.json": pkg({ bad: "1.0.0" }) }, /npm error code EINTEGRITY/],
  ])("fails cleanly on %s", async (_name, files, message) => {
    const t = setup({ left: { versions: { "1.0.0": {} } }, bad: { versions: { "1.0.0": { corrupt: true } } } }, files);
    const r = await t.run(["install"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(message);
  });

  it("flat overrides replace every transitive dependency on a name - the way to swap in a wasm build", async () => {
    const t = setup(
      {
        vite: { versions: { "7.1.0": { dependencies: { esbuild: "^0.25.0", rollup: "^4.0.0" } } } },
        plugin: { versions: { "1.0.0": { dependencies: { esbuild: "^0.24.0" } } } },
        esbuild: { versions: { "0.25.1": { optionalDependencies: {} } } },
        "esbuild-wasm": { versions: { "0.25.1": {} } },
        rollup: { versions: { "4.2.0": {} } },
        "@rollup/wasm-node": { versions: { "4.2.0": {} } },
      },
      {
        "/app/package.json": pkg(
          { vite: "^7.0.0", plugin: "1.0.0" },
          {
            devDependencies: { "wasm-rollup": "npm:@rollup/wasm-node@^4.0.0" },
            overrides: { esbuild: "npm:esbuild-wasm@^0.25.0", rollup: "$wasm-rollup", "vite@7": "7.0.0", plugin: { esbuild: "1" } },
          },
        ),
      },
    );
    const r = await t.run(["install"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe(
      'npm warn ignoring override "vite@7": only the flat "name": "spec" form is supported\n' +
        'npm warn ignoring override "plugin": only the flat "name": "spec" form is supported\n',
    );
    // One esbuild-wasm serves both vite's ^0.25 and plugin's ^0.24 - the override applies to every edge.
    expect(t.json("/app/node_modules/esbuild/package.json")).toMatchObject({ name: "esbuild-wasm", version: "0.25.1" });
    expect(t.json("/app/node_modules/rollup/package.json")).toMatchObject({ name: "@rollup/wasm-node", version: "4.2.0" });
    expect(t.fs.exists("/app/node_modules/vite/node_modules")).toBe(false);
    expect(t.fs.exists("/app/node_modules/plugin/node_modules")).toBe(false);
    expect(t.requests.some((url) => url.endsWith("/esbuild") || url.endsWith("/rollup"))).toBe(false);
  });

  it("reports install scripts it didn't run", async () => {
    const t = setup({ native: { versions: { "1.0.0": { hasInstallScript: true } } } }, { "/app/package.json": pkg({ native: "1" }) });
    const r = await t.run(["install"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("npm warn install scripts were not run (wcvm's npm never runs them): native\n");
  });

  it("takes the registry from --registry, over the environment", async () => {
    const t = setup({ left: { versions: { "1.0.0": {} } } }, { "/app/package.json": pkg({ left: "1" }) });
    const r = await t.run(["install", "--registry", FAKE_REGISTRY], { npm_config_registry: "https://elsewhere.test/" });
    expect(r.code).toBe(0);
    expect(t.requests.every((url) => url.startsWith(FAKE_REGISTRY))).toBe(true);
  });

  it("only `install` and `run` are supported", async () => {
    const t = setup({});
    expect((await t.run([])).code).toBe(1);
    expect(await t.run(["publish"])).toMatchObject({ code: 1, stderr: expect.stringContaining('"publish" is not supported') });
    expect(await t.run(["--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: npm install") });
  });
});

describe("npm run", () => {
  const scriptsPkg = (scripts: Record<string, string>, extra: Record<string, unknown> = {}) => JSON.stringify({ name: "app", version: "1.0.0", scripts, ...extra });

  it("runs a script with real npm's own banner, and forwards trailing args onto the command line", async () => {
    const t = setup({}, { "/app/package.json": scriptsPkg({ dev: "echo hi" }) });
    const r = await t.run(["run", "dev", "--", "a", "b"]);
    expect(r).toEqual({ code: 0, stdout: "\n> app@1.0.0 dev\n> echo hi a b\n\nhi a b\n", stderr: "" });
  });

  it("runs pre<x> then <x> then post<x>, in order", async () => {
    const t = setup({}, { "/app/package.json": scriptsPkg({ predev: "echo PRE", dev: "echo DEV", postdev: "echo POST" }) });
    const r = await t.run(["run", "dev"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("\n> app@1.0.0 predev\n> echo PRE\n\nPRE\n\n> app@1.0.0 dev\n> echo DEV\n\nDEV\n\n> app@1.0.0 postdev\n> echo POST\n\nPOST\n");
  });

  it("a failing pre<x> stops <x> and post<x> from ever running, and relays its exit code with no extra npm error text", async () => {
    const t = setup({}, { "/app/package.json": scriptsPkg({ predev: "false", dev: "echo DEV", postdev: "echo POST" }) });
    const r = await t.run(["run", "dev"]);
    expect(r).toEqual({ code: 1, stdout: "\n> app@1.0.0 predev\n> false\n\n", stderr: "" });
  });

  it("--ignore-scripts skips pre/post hooks", async () => {
    const t = setup({}, { "/app/package.json": scriptsPkg({ predev: "echo PRE", dev: "echo DEV", postdev: "echo POST" }) });
    const r = await t.run(["run", "dev", "--ignore-scripts"]);
    expect(r.stdout).toBe("\n> app@1.0.0 dev\n> echo DEV\n\nDEV\n");
  });

  it("a missing script fails with real npm's own message; --if-present makes it a silent no-op instead", async () => {
    const t = setup({}, { "/app/package.json": scriptsPkg({}) });
    const r = await t.run(["run", "missing"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe('npm error Missing script: "missing"\nnpm error \nnpm error To see a list of scripts, run:\nnpm error   npm run\n');
    expect(await t.run(["run", "missing", "--if-present"])).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  it("`npm run` with no script name lists them, split into lifecycle vs. custom - or prints nothing at all if there are none", async () => {
    const t = setup({}, { "/app/package.json": scriptsPkg({ start: "node index.js", build: "echo build" }) });
    expect((await t.run(["run"])).stdout).toBe("Lifecycle scripts included in app@1.0.0:\n  start\n    node index.js\navailable via `npm run`:\n  build\n    echo build\n");

    const empty = setup({}, { "/app/package.json": scriptsPkg({}) });
    expect(await empty.run(["run"])).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  it("`npm start` falls back to `node server.js` when there's no start script but server.js exists", async () => {
    const t = setup({}, { "/app/package.json": JSON.stringify({ name: "app", version: "1.0.0" }), "/app/server.js": "console.log('serving')" });
    const r = await t.run(["start"]);
    expect(r).toEqual({ code: 0, stdout: "\n> app@1.0.0 start\n> node server.js\n\nserving\n", stderr: "" });
  }, 20_000); // boots a real Node runtime

  it("`npm restart` falls back to `npm stop --if-present && npm start` when there's no restart script", async () => {
    const t = setup({}, { "/app/package.json": scriptsPkg({ start: "echo STARTED" }) });
    const r = await t.run(["restart"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("\n> app@1.0.0 restart\n> npm stop --if-present && npm start\n\n\n> app@1.0.0 start\n> echo STARTED\n\nSTARTED\n");
  });

  it("`npm test`/`t`/`tst` and `npm stop` are aliases for the matching script event", async () => {
    const t = setup({}, { "/app/package.json": scriptsPkg({ test: "echo TESTED", stop: "echo STOPPED" }) });
    expect((await t.run(["t"])).stdout).toContain("TESTED\n");
    expect((await t.run(["tst"])).stdout).toContain("TESTED\n");
    expect((await t.run(["stop"])).stdout).toContain("STOPPED\n");
  });

  it("`run-script`/`rum`/`urn` are aliases for `run`", async () => {
    const t = setup({}, { "/app/package.json": scriptsPkg({ dev: "echo hi" }) });
    for (const alias of ["run-script", "rum", "urn"]) expect((await t.run([alias, "dev"])).stdout).toContain("hi\n");
  });

  it("prepends every ancestor node_modules/.bin to PATH, so a script can invoke its own installed bin", async () => {
    const t = setup({}, { "/app/package.json": scriptsPkg({ dev: "greet" }) });
    t.fs.mkdir("/app/node_modules/.bin", { recursive: true });
    t.fs.writeFile("/app/node_modules/.bin/greet", "#!/usr/bin/env node\nconsole.log('hi from a bin');\n");
    const r = await t.run(["run", "dev"]);
    expect(r).toMatchObject({ code: 0, stdout: expect.stringContaining("hi from a bin\n") });
  }, 20_000); // boots a real Node runtime for the resolved bin

  it("without a package.json at all, fails like npm install's own ENOENT does", async () => {
    const t = setup({});
    const r = await t.run(["run", "dev"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^npm error code ENOENT\nnpm error Could not read package\.json/);
  });
});
