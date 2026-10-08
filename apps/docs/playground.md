---
title: Playground
outline: false
aside: false
pageClass: wide-page
---

# Playground

Real Node.js, running in this page: a full editor with a file tree, a terminal and a live preview. Pick an example, edit it, and save. Everything runs in your tab (each process is a Web Worker, files live in an in-memory filesystem) and nothing leaves your browser.

<EmbedPlayground picker example="server" />

## What to try

- **A Node script:** ESM `import`, `node:crypto` hashing, and `process.version`.
- **An HTTP server with live preview:** a real `http.createServer()` served into the preview pane over wcvm's virtual network.
- Open the terminal and run your own commands: `node -e`, `npm install`, `ls`, pipes and redirects all work.

For project templates (React, Vue, Next.js, SvelteKit, Angular and more), [open Studio](https://studio.wcvmjs.com): it is the same editor, embedded here with `@wcvm/sdk`.

::: tip Embed it in your own page
This playground is [`EmbedPlayground.vue`](https://github.com/duyduc-dev/wcvm/blob/main/apps/docs/.vitepress/theme/EmbedPlayground.vue), about 100 lines around `embed()` from [`@wcvm/sdk`](https://www.npmjs.com/package/@wcvm/sdk). Your page needs the [cross-origin isolation headers](/guide/headers).
:::
