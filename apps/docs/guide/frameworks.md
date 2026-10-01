# Frameworks

Every framework below is exercised in real Chromium by the repository's end-to-end tests: installed from the real npm registry, started with its dev command, and served through the preview. [Studio](https://studio.wcvmjs.com) packages them as project templates, with the working recipes in `apps/studio/src/services/wcvm/templateProjects/`.

| Framework | Notes |
|---|---|
| **Vite** (React, Vue, Preact, Lit, Solid, Qwik, Svelte, vanilla) | Vite 7 with the WebAssembly esbuild and rollup. |
| **Tailwind CSS v4** | Needs `lightningcss` swapped for `lightningcss-wasm` and a patch to `@tailwindcss/vite` (see below). |
| **Next.js** (TypeScript, JavaScript) | `next dev --webpack` with the WebAssembly SWC. The first page compiles for 15 to 30 seconds. |
| **SvelteKit** | The `sv create` demo app. |
| **React Router 7** | Framework mode. |
| **Astro** | 6.x. |
| **Angular** | 22, `ng serve`. |
| **Ember** | JavaScript and TypeScript, the Vite blueprint. |
| **Express**, **NestJS** | TypeScript is compiled with `tsc` and run with `node`; there is no watch and restart. |

## Pins that make Vite-based projects run

Native binaries cannot run in a browser, so these packages are swapped for their WebAssembly builds in `package.json`:

```json
{
  "devDependencies": { "vite": "7.3.6" },
  "overrides": {
    "esbuild": "npm:esbuild-wasm@0.28.2",
    "rollup": "npm:@rollup/wasm-node@4.63.4",
    "lightningcss": "npm:lightningcss-wasm@1.30.2"
  }
}
```

Vite 8 defaults to Rolldown, which has no WebAssembly build here, so projects stay on **Vite 7**. Plugins need versions compatible with it, for example `@vitejs/plugin-react` `^5`, `@vitejs/plugin-vue` `^6` and `@sveltejs/vite-plugin-svelte` `^6.2.4`.

## Environment variables

Set these in `env` when you spawn the shell or command:

| Variable | For |
|---|---|
| `JOBS=1` | Ember: its build otherwise starts a `child_process.fork` worker pool that never answers, and hangs. |
| `NG_BUILD_BABEL_LINKER=true`, `NG_BUILD_OPTIMIZE_CHUNKS=false` | Angular: use Babel for partial-compilation linking, and skip the one production step that needs native `rolldown`. |
| `NEXT_TELEMETRY_DISABLED=1`, `ASTRO_TELEMETRY_DISABLED=1` | Stop Next.js and Astro trying to report usage. |
| `FORCE_COLOR=3` | Colored output from npm, Vite and similar tools, which otherwise detect there is no TTY. |

## Things a framework needs from you

- **No `postinstall`.** wcvm's npm never runs lifecycle scripts. Next.js looks for its WebAssembly SWC at `node_modules/next/wasm/@next/swc-wasm-nodejs`, so create that link yourself after install (paths are relative to the project):
  `symlink("../../../@next/swc-wasm-nodejs", "node_modules/next/wasm/@next/swc-wasm-nodejs")`.
- **A base path for client-side routers.** The preview serves your app under `/__wcvm_preview__/<port>/`, but your dev server only sees paths with that prefix removed. React Router and TanStack Router need the prefix at runtime (read it from `location`); Angular and Ember use hash routing. SvelteKit, Next.js and Astro need nothing.

## Not supported yet

- **Nuxt.** `oxc-parser`'s WebAssembly binding deadlocks (see [Limitations](/reference/limitations)), and Nuxt 4 needs Vite 8.
- **Vite 8 / Rolldown** and any package that needs a native add-on.
