// The playground's React example: a real Vite + React + TypeScript app, run entirely inside
// wcvm. One click writes the project into the virtual filesystem, installs it from the real npm
// registry with wcvm's own `npm install`, and starts Vite's real CLI via `npm run dev`; the
// preview pane (src/preview.ts) points itself at the dev server the moment it listens. The
// App.tsx editor writes straight into the running project, so every edit hot-updates the
// component in place (React Fast Refresh - its state survives). Shares its actual run/stop/edit
// machinery with vueExample.ts via viteExample.ts's `attachViteExample`.

import type { IWcvm } from "wcvm";
import { attachViteExample, type IViteExampleHandle } from "./viteExample";

const PROJECT = "/react-app";
const PORT = 5173;

const APP_TSX = `import { useState } from 'react';
import './App.css';

export default function App() {
  const [count, setCount] = useState(0);

  return (
    <main>
      <h1>Vite + React + TypeScript</h1>
      <p>Running entirely in your browser tab, inside wcvm.</p>
      <button id="count" onClick={() => setCount((c) => c + 1)}>
        count is {count}
      </button>
      <p>Edit <code>src/App.tsx</code> - the count survives every edit.</p>
    </main>
  );
}
`;

/** The rest of a `create-vite` react-ts project (App.tsx comes from the editor). esbuild and Rollup
 *  are swapped for their WebAssembly builds: their native binaries can't run in a browser. */
const PROJECT_FILES: Record<string, string> = {
  "package.json": JSON.stringify(
    {
      name: "react-app",
      private: true,
      type: "module",
      scripts: { dev: "vite" },
      dependencies: { react: "^19.1.0", "react-dom": "^19.1.0" },
      devDependencies: { "@vitejs/plugin-react": "^5.0.0", vite: "7.3.6" },
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
    <title>Vite + React + TS</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
  "vite.config.ts": `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
});
`,
  "tsconfig.json": JSON.stringify(
    {
      compilerOptions: { target: "ES2022", lib: ["ES2022", "DOM", "DOM.Iterable"], jsx: "react-jsx", module: "ESNext", moduleResolution: "bundler", strict: true, skipLibCheck: true, noEmit: true },
      include: ["src"],
    },
    null,
    2,
  ),
  "src/main.tsx": `import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
`,
  "src/App.css": `main { font-family: system-ui, sans-serif; padding: 1.5rem; text-align: center; }
h1 { color: #646cff; }
button { font-size: 1rem; padding: 0.5rem 1rem; border-radius: 8px; border: 1px solid #646cff; cursor: pointer; }
`,
};

export const attachReactExample = (
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
    { project: PROJECT, port: PORT, name: "React", files: PROJECT_FILES, editablePath: "src/App.tsx", initialContent: APP_TSX },
    elements,
  );
