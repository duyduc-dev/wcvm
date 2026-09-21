import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: true,
    sourcemap: true,
    // No `clean` here: the configs build in parallel, so this one's clean
    // can delete the worker output the other just wrote. The `build` script
    // clears dist/ before tsup starts instead.
    clean: false,
  },
  {
    entry: {
      "workers/kernel/worker": "src/workers/kernel/worker.ts",
      "workers/fs/worker": "src/workers/fs/worker.ts",
      "workers/process/worker": "src/workers/process/worker.ts",
    },
    format: ["esm"],
    sourcemap: true,
    clean: false,
    // Each of these is loaded standalone via `new Worker(url)` / SW
    // registration - a raw URL fetch, not a bundler-resolved import. Code-
    // splitting would factor shared code into sibling chunk-*.js files that
    // only exist inside this package's own dist/, so a consumer bundler
    // (e.g. Vite) that copies one of these worker files out to its own
    // assets/ dir - rather than recursively re-bundling it - ships a file
    // whose imports 404. Confirmed live: duckwc/dist/workers/fs/worker.js
    // importing "../../chunk-*.js" broke exactly this way once deployed.
    splitting: false,
  },
]);
