---
title: Playground
outline: false
---

# Playground

Real Node.js, running in this page. Pick an example, edit it, and press **Run** (or Cmd/Ctrl+S). Each run is a new process in its own Web Worker; the files live in an in-memory filesystem that only exists in your tab.

<LiveDemo picker example="hello" />

## What to try

- **Hello, Node:** ESM `import`, `node:crypto` hashing, and `process.version`.
- **An HTTP server:** a real `http.createServer()` and `http.get()` talking over wcvm's virtual network.
- **Files and streams:** `fs`, `readline` and a read stream over an in-memory file.
- **Child processes:** `execSync` and `spawn`, each child being another worker.

A run is stopped after 15 seconds. For long-running servers, `npm install`, a file tree and a live preview, [open Studio](https://studio.wcvmjs.com): it is the same runtime with an editor, terminals and project templates.

::: tip Embed it in your own page
The demo is a few hundred lines of Vue plus `wcvm` itself: see [`apps/docs/.vitepress/theme/LiveDemo.vue`](https://github.com/duyduc-dev/wcvm/blob/main/apps/docs/.vitepress/theme/LiveDemo.vue). Your page needs the [cross-origin isolation headers](/guide/headers).
:::
