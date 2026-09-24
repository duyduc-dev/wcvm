import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { builtinFactories, NODE_VERSION, perContextFactories } from "./node/registry";

const root = new URL("./node/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", root), "utf8"));
const lock = JSON.parse(readFileSync(new URL("vendor.lock.json", root), "utf8"));

describe("vendored Node lib", () => {
  it("is byte-for-byte upstream apart from the wrapper (checked against recorded sha256)", () => {
    // Exits non-zero, naming the file, if any vendored body was edited.
    expect(() =>
      execFileSync(process.execPath, ["scripts/vendor-node-lib.mjs", "--check"], {
        cwd: new URL("../../", import.meta.url),
        stdio: "pipe",
      }),
    ).not.toThrow();
  });

  const SHIMMED = [
    "internal/url",
    "internal/encoding",
    "internal/blob",
    "internal/bootstrap/realm",
    "dns",
    "cluster",
    "tls",
    "https",
    "inspector",
    "inspector/promises",
  ];

  it("registers exactly the modules in the manifest, at one pinned version", () => {
    const registered = [...Object.keys(builtinFactories), ...Object.keys(perContextFactories)];
    const shimmed = new Set(SHIMMED);
    const vendored = registered.filter((id) => !shimmed.has(id));
    expect(vendored.sort()).toEqual(Object.keys(manifest.modules).sort());
    expect(Object.keys(lock.files).sort()).toEqual(Object.keys(manifest.modules).sort());
    expect(manifest.version).toBe(NODE_VERSION);
    expect(lock.version).toBe(NODE_VERSION);
  });

  it("does not vendor modules that are shimmed by hand", () => {
    // A vendored copy would be shadowed by the shim, hiding which one runs.
    for (const id of SHIMMED) {
      expect(manifest.modules).not.toHaveProperty(id);
    }
  });
});
