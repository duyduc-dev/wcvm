// The playground's Vue example: a real Vite + Vue app, run entirely inside wcvm - the second
// proof (after reactExample.ts) that the whole npm-install-then-`npm run dev`-then-preview
// pipeline (viteExample.ts's `attachViteExample`) is generic, not React-specific. One click
// writes the project into the virtual filesystem, installs it from the real npm registry with
// wcvm's own `npm install`, and starts Vite's real CLI via `npm run dev`. The App.vue editor
// writes straight into the running project, so every edit hot-updates the component in place.

import type { IWcvm } from "wcvm";
import { attachViteExample, type IViteExampleHandle } from "./viteExample";

const PROJECT = "/vue-app";
const PORT = 5174;

const APP_VUE = `<script setup>
import { ref } from 'vue';

const count = ref(0);
</script>

<template>
  <main>
    <h1>Vite + Vue</h1>
    <p>Running entirely in your browser tab, inside wcvm.</p>
    <button id="count" @click="count++">count is {{ count }}</button>
    <p>Edit <code>src/App.vue</code> - the count survives every edit.</p>
  </main>
</template>

<style>
main { font-family: system-ui, sans-serif; padding: 1.5rem; text-align: center; }
h1 { color: #42b883; }
button { font-size: 1rem; padding: 0.5rem 1rem; border-radius: 8px; border: 1px solid #42b883; cursor: pointer; }
</style>
`;

/** The rest of a `create-vite` vue (JS) project (App.vue comes from the editor). esbuild and
 *  Rollup are swapped for their WebAssembly builds: their native binaries can't run in a browser. */
const PROJECT_FILES: Record<string, string> = {
  "package.json": JSON.stringify(
    {
      name: "vue-app",
      private: true,
      type: "module",
      scripts: { dev: "vite" },
      dependencies: { vue: "^3.5.0" },
      devDependencies: { "@vitejs/plugin-vue": "^6.0.0", vite: "7.3.6" },
      overrides: { esbuild: "npm:esbuild-wasm@0.28.2", rollup: "npm:@rollup/wasm-node@4.63.4" },
    },
    null,
    2,
  ),
  "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Vite + Vue</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.js"></script>
  </body>
</html>
`,
  "vite.config.js": `import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
});
`,
  "src/main.js": `import { createApp } from 'vue';
import App from './App.vue';

createApp(App).mount('#app');
`,
};

export const attachVueExample = (
  wc: IWcvm,
  elements: {
    runButton: HTMLButtonElement;
    status: HTMLElement;
    editor: HTMLTextAreaElement;
    writeToTerminal?: (text: string) => void;
    onBeforeStart?: () => void;
  },
): IViteExampleHandle =>
  attachViteExample(
    wc,
    { project: PROJECT, port: PORT, name: "Vue", editablePath: "src/App.vue", source: { kind: "static", files: PROJECT_FILES, initialContent: APP_VUE } },
    elements,
  );
