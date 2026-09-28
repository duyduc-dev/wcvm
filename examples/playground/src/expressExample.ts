// The playground's fourth example: a plain Node + Express server, no bundler/dev-server at all -
// the other side of "dev server templates" from the Vite examples (React/Vue), and deliberately
// NOT Svelte: Svelte's real compiler has genuine circular static ESM imports in its own source
// (confirmed against svelte@5.0.0 through @5.57.1 - it's structural, not a version-pinning issue),
// which wcvm's ESM loader can't yet support (creating one `blob:` URL per module up front means
// two mutually-referencing modules can never both be created first - see CLAUDE.md's ESM "Known
// differences"). Parked; see PLAN.md. This example instead proves the OTHER end of the "install
// from npm, run entirely in this tab" pipeline still works for a plain server with no client JS
// and no HMR: editing server.js restarts the whole process (wcvm's own `npm start` fallback -
// there's no "start" script, so it runs `node server.js`, exactly like real npm), and the shared
// preview pane naturally blanks and re-renders when it comes back up (`preview.ts`'s own
// `onListen()` wiring - nothing new needed there).

import type { IWcvm } from "wcvm";
import { buildTree, collect, type Process } from "./viteExample";

const PROJECT = "/express-app";
const PORT = 5176;

const SERVER_JS = `const express = require('express');
const app = express();

let count = 0;

app.get('/', (req, res) => {
  res.send(\`<!doctype html>
<html>
  <head><title>Node + Express</title></head>
  <body style="font-family: system-ui, sans-serif; padding: 1.5rem; text-align: center;">
    <h1>Node + Express</h1>
    <p>Running entirely in your browser tab, inside wcvm - no bundler, no client JS.</p>
    <form method="post" action="/count">
      <button id="count">count is \${count}</button>
    </form>
    <p>Edit <code>server.js</code> here - the server restarts (there's no HMR for a plain
    server, so the preview reloads and the count above resets).</p>
  </body>
</html>\`);
});

app.post('/count', (req, res) => {
  count++;
  res.redirect('/');
});

const port = process.env.PORT;
app.listen(port, () => console.log('Express server listening on ' + port));
`;

/** Only `dependencies` - no `scripts` at all, so `npm start` exercises wcvm's own real fallback
 *  (no "start" script + a `server.js` file at the root -> `node server.js`, matching real npm). */
const PACKAGE_JSON = JSON.stringify({ name: "express-app", private: true, dependencies: { express: "^5.0.0" } }, null, 2);

export interface IExpressExampleHandle {
  stop(message: string): void;
}

export const attachExpressExample = (
  wc: IWcvm,
  elements: {
    runButton: HTMLButtonElement;
    status: HTMLElement;
    editor: HTMLTextAreaElement;
    writeToTerminal?: (text: string) => void;
    onBeforeStart?: () => void;
  },
): IExpressExampleHandle => {
  const { runButton, status, editor, writeToTerminal, onBeforeStart } = elements;
  editor.value = SERVER_JS;

  let server: Process | undefined;
  let projectWritten = false;

  const reportFailure = (message: string) => {
    server?.kill();
    server = undefined;
    runButton.textContent = "run Express example";
    status.textContent = message;
  };

  const stop = (message: string) => {
    if (!server) return; // nothing running - e.g. another example's onBeforeStart calling this one
    reportFailure(message);
  };

  /** Writes the editor's current content to server.js, then spawns `npm start` fresh - used both
   *  for the very first run and for every restart-on-edit afterward. */
  const spawnServer = async () => {
    await wc.fs.writeFile(`${PROJECT}/server.js`, editor.value);
    const proc = await wc.spawn("npm", ["start"], { cwd: PROJECT, env: { PORT: String(PORT), FORCE_COLOR: "3" } });
    server = proc;
    let log = "";
    collect(proc, (text) => {
      log += text;
      if (/Express server listening/.test(log) && server === proc) {
        status.textContent = `Express is running on virtual port ${PORT} - the app is in the preview pane below. Edit server.js here; the server restarts on every edit.`;
      }
    }, writeToTerminal);
    proc.exit.then((result) => {
      if (server !== proc) return; // already stopped/restarted
      stop(`Express exited unexpectedly (code ${result.exitCode}):\n${log.trim().split("\n").slice(-5).join("\n")}`);
    });
  };

  // Unlike the Vite examples' own file watcher, a plain server has no HMR - every edit restarts
  // the whole process from scratch. The shared preview pane blanks while it's down and re-renders
  // once it relistens (preview.ts's own onListen() wiring), so no extra UI work is needed here.
  let pending: ReturnType<typeof setTimeout> | undefined;
  const restart = async () => {
    if (!server) return; // not running yet - the edit is just queued as the initial content
    status.textContent = "Restarting...";
    server.kill();
    server = undefined;
    try {
      await spawnServer();
    } catch (error) {
      reportFailure(`Failed to restart: ${(error as Error).message}`);
    }
  };
  editor.addEventListener("input", () => {
    if (!projectWritten) return;
    clearTimeout(pending);
    pending = setTimeout(() => void restart(), 250);
  });

  const start = async () => {
    onBeforeStart?.();
    await wc.preview.enable();

    if (!projectWritten) {
      await wc.fs.mount(buildTree({ "package.json": PACKAGE_JSON }), PROJECT);
      projectWritten = true;
    }

    status.textContent = "Installing Express from registry.npmjs.org with wcvm's npm install (~5s the first time)...";
    const install = await wc.spawn("npm", ["install"], { cwd: PROJECT, env: { FORCE_COLOR: "3" } });
    let installLog = "";
    collect(install, (text) => (installLog += text), writeToTerminal);
    const installed = await install.exit;
    if (installed.exitCode !== 0) throw new Error(`npm install failed:\n${installLog.trim()}`);

    status.textContent = `${installLog.trim()} - starting the server...`;
    await spawnServer();
    runButton.textContent = "stop Express example";
  };

  runButton.addEventListener("click", async () => {
    if (server) {
      stop("Stopped.");
      return;
    }
    runButton.disabled = true;
    status.textContent = "Writing the project...";
    try {
      await start();
    } catch (error) {
      reportFailure(`Failed to start: ${(error as Error).message}`);
    } finally {
      runButton.disabled = false;
    }
  });

  return { stop };
};
