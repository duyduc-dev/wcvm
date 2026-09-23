// A small, self-contained example: a REAL Node.js http.createServer() (not a mock), spawned as a
// real process (its own Web Worker), showing off the Node runtime, real http, and the preview
// relay (src/preview.ts) together - clicking "run" spawns it, and the already-wired preview pane
// picks it up live via wc.preview.onListen(), no manual refresh needed.

import type { IWcvm } from "wcvm";

const EXAMPLE_PORT = 3000;

export const EXAMPLE_SERVER_SCRIPT = String.raw`
const http = require('http');
const fs = require('fs');

const NOTES_FILE = '/example-notes.json';
if (!fs.existsSync(NOTES_FILE)) fs.writeFileSync(NOTES_FILE, '[]');

const readNotes = () => JSON.parse(fs.readFileSync(NOTES_FILE, 'utf8'));

const server = http.createServer((req, res) => {
  const [pathname, query = ''] = req.url.split('?');

  if (pathname === '/api/time') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ time: new Date().toISOString() }));
    return;
  }

  if (pathname === '/add') {
    const match = /text=([^&]*)/.exec(query);
    const text = match ? decodeURIComponent(match[1].replace(/\+/g, ' ')) : '';
    if (text) {
      const notes = readNotes();
      notes.push(text);
      fs.writeFileSync(NOTES_FILE, JSON.stringify(notes));
    }
    res.statusCode = 302;
    // Relative, not '/' - a preview page is served under /__wcvm_preview__/<port>/, and that
    // prefix is only in the BROWSER's own address bar for this navigation, not something the
    // guest server itself knows about (parsePreviewPath already strips it from req.url above) -
    // an absolute '/' would escape the preview prefix entirely and load the playground app
    // itself instead of this server's own root.
    res.setHeader('Location', '.');
    res.end();
    return;
  }

  const items = readNotes().map((note) => '<li>' + note + '</li>').join('');
  res.setHeader('Content-Type', 'text/html');
  res.end(
    '<!doctype html><html><body style="font-family: sans-serif; padding: 1.5rem;">' +
      '<h2>Hello from a real Node.js server</h2>' +
      '<p>This page is served by a real http.createServer() running entirely inside your browser tab, in a Web Worker - no backend.</p>' +
      '<p><a href="api/time">api/time</a> returns real JSON from the same server.</p>' +
      "<h3>Notes, stored in wcvm's own virtual filesystem</h3>" +
      '<ul>' + items + '</ul>' +
      '<form action="add"><input name="text" placeholder="Add a note" autofocus /> <button>Add</button></form>' +
      '</body></html>',
  );
});

server.listen(${EXAMPLE_PORT}, () => console.log('Example server listening on http://localhost:${EXAMPLE_PORT}'));
`.trim();

export const attachExampleServer = (
  wc: IWcvm,
  elements: { runButton: HTMLButtonElement; status: HTMLElement; source: HTMLElement },
) => {
  const { runButton, status, source } = elements;
  source.textContent = EXAMPLE_SERVER_SCRIPT;

  let proc: Awaited<ReturnType<typeof wc.spawn>> | undefined;

  const stop = (message: string) => {
    proc?.kill();
    proc = undefined;
    runButton.textContent = "run example server";
    status.textContent = message;
  };

  runButton.addEventListener("click", async () => {
    if (proc) {
      stop("Stopped.");
      return;
    }
    runButton.disabled = true;
    status.textContent = "Starting...";
    try {
      await wc.preview.enable();
      const started = await wc.spawn("node", ["-e", EXAMPLE_SERVER_SCRIPT]);
      proc = started;
      runButton.textContent = "stop example server";
      status.textContent = `Running on virtual port ${EXAMPLE_PORT} - see it live in the preview pane below.`;
      started.exit.then((result) => {
        if (proc !== started) return; // already stopped (or restarted) by the user
        stop(`Example server exited unexpectedly (code ${result.exitCode}).`);
      });
    } catch (error) {
      status.textContent = `Failed to start: ${(error as Error).message}`;
    } finally {
      runButton.disabled = false;
    }
  });
};
