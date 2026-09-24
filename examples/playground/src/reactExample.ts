// The playground's example: a real Vite + React + TypeScript app, run entirely inside wcvm. One
// click writes the project into the virtual filesystem, installs it from the real npm registry
// with wcvm's own `npm install`, and starts Vite's real CLI; the preview pane (src/preview.ts)
// points itself at the dev server the moment it listens. The App.tsx editor writes straight into
// the running project, so every edit hot-updates the component in place (React Fast Refresh -
// its state survives).

import type { IWcvm } from "wcvm";

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

type Process = Awaited<ReturnType<IWcvm["spawn"]>>;

/** Everything a process writes, as text, as it arrives. */
const collect = (proc: Process, onText: (text: string) => void) => {
  for (const stream of [proc.stdout, proc.stderr]) {
    void (async () => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        onText(decoder.decode(value));
      }
    })();
  }
};

export const attachReactExample = (
  wc: IWcvm,
  elements: { runButton: HTMLButtonElement; status: HTMLElement; editor: HTMLTextAreaElement },
) => {
  const { runButton, status, editor } = elements;
  editor.value = APP_TSX;

  let vite: Process | undefined;
  let projectWritten = false;

  const writeApp = () => wc.fs.writeFile(`${PROJECT}/src/App.tsx`, editor.value);

  // Every edit lands in the running project; Vite's watcher picks it up and hot-updates it.
  let pending: ReturnType<typeof setTimeout> | undefined;
  editor.addEventListener("input", () => {
    if (!projectWritten) return; // used as the starting App.tsx on the next run instead
    clearTimeout(pending);
    pending = setTimeout(() => void writeApp(), 250);
  });

  const stop = (message: string) => {
    vite?.kill();
    vite = undefined;
    runButton.textContent = "run React example";
    status.textContent = message;
  };

  const start = async () => {
    await wc.preview.enable();

    for (const [path, contents] of Object.entries(PROJECT_FILES)) {
      const full = `${PROJECT}/${path}`;
      await wc.fs.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
      await wc.fs.writeFile(full, contents);
    }
    await writeApp();
    projectWritten = true;

    status.textContent = "Installing React, Vite and friends from registry.npmjs.org with wcvm's npm install (~10s the first time)...";
    const install = await wc.spawn("npm", ["install"], { cwd: PROJECT });
    let installLog = "";
    collect(install, (text) => (installLog += text));
    const installed = await install.exit;
    if (installed.exitCode !== 0) throw new Error(`npm install failed:\n${installLog.trim()}`);

    status.textContent = `${installLog.trim()} - starting Vite...`;
    const started = await wc.spawn("node", ["node_modules/vite/bin/vite.js", "--port", String(PORT), "--strictPort"], { cwd: PROJECT });
    vite = started;
    runButton.textContent = "stop React example";
    let log = "";
    collect(started, (text) => {
      log += text;
      if (/Local:/.test(log) && vite === started) {
        status.textContent = `Vite is running on virtual port ${PORT} - the app is in the preview pane below. Edit src/App.tsx here and watch it hot-reload.`;
      }
    });
    started.exit.then((result) => {
      if (vite !== started) return; // already stopped (or restarted) by the user
      stop(`Vite exited unexpectedly (code ${result.exitCode}):\n${log.trim().split("\n").slice(-5).join("\n")}`);
    });
  };

  runButton.addEventListener("click", async () => {
    if (vite) {
      stop("Stopped.");
      return;
    }
    runButton.disabled = true;
    status.textContent = "Writing the project...";
    try {
      await start();
    } catch (error) {
      stop(`Failed to start: ${(error as Error).message}`);
    } finally {
      runButton.disabled = false;
    }
  });
};
