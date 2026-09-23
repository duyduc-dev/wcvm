#!/usr/bin/env node
// Dev tool: finds which Node lib/ modules a target needs by loading it against
// the vendored set, adding whatever the loader reports missing to manifest.json,
// vendoring it, and trying again.
//
//   node --import ./src/testing/registerTsResolve.mjs scripts/discover-node-lib.mjs events util
//
// Runs against the real bindings in src/runtime/bindings/, so a failure that is
// not "module missing" means a binding needs work; that is reported, not skipped.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const manifestPath = join(here, "..", "src", "runtime", "node", "manifest.json");
const targets = process.argv.slice(2);
const MAX_ROUNDS = 400;

const permissive = () => {
  const make = () =>
    new Proxy(function () {}, {
      get: (_t, key) => (key === Symbol.toPrimitive ? () => 0 : key === "then" ? undefined : make()),
      apply: () => make(),
      construct: () => make(),
      has: () => true,
    });
  return make();
};

for (let round = 0; round < MAX_ROUNDS; round++) {
  // Re-import in a fresh process each round: the registry changes on disk.
  const probe = `
    import { createBuiltinLoader } from "./src/runtime/loader.ts";
    import { createPrimordials } from "./src/runtime/primordials.ts";
    import { createInternalBinding } from "./src/runtime/bindings/index.ts";
    const process = { versions: {}, env: {}, argv: [], platform: "linux", emitWarning() {}, cwd: () => "/", nextTick: (f, ...a) => queueMicrotask(() => f(...a)) };
    let loader;
    import { EventLoop } from "./src/runtime/eventLoop.ts";
    import { createLoopbackFs } from "./src/testing/loopbackFs.ts";
    // A truthy childProcess satisfies pipe_wrap/process_wrap/stream_wrap's constructor-time
    // check (ChildRouter throws ENOSYS without one) - net.js and http.js both require those
    // unconditionally at module load now, even for a probe that never actually spawns anything.
    const internalBinding = createInternalBinding({ requireBuiltin: (id) => loader.requireBuiltin(id), loop: new EventLoop(), fs: createLoopbackFs().fs, process, childProcess: { onEvent: () => {} } });
    loader = createBuiltinLoader({ process, internalBinding, primordials: createPrimordials() });
    try { for (const t of ${JSON.stringify(targets)}) loader.requireBuiltin(t); console.log("OK"); }
    catch (e) { console.log(e.code === "ERR_UNKNOWN_BUILTIN_MODULE" ? "MISSING " + /'([^']+)'/.exec(e.message)[1] : "ERROR " + (e.stack || e).toString().split("\\n").slice(0, 6).join(" | ")); }
  `;
  const out = execFileSync(
    process.execPath,
    ["--import", "./src/testing/registerTsResolve.mjs", "--input-type=module", "-e", probe],
    { encoding: "utf8", cwd: join(here, "..") },
  ).trim();

  if (out === "OK") {
    console.log(`resolved: ${targets.join(", ")} (${round} modules added)`);
    process.exit(0);
  }
  const missing = /^MISSING (.+)$/.exec(out)?.[1];
  if (!missing) {
    console.error(out);
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.modules[missing] = "builtin";
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  execFileSync(process.execPath, [join(here, "vendor-node-lib.mjs")], { stdio: "pipe" });
  console.log(`+ ${missing}`);
}
console.error("gave up");
process.exit(1);
