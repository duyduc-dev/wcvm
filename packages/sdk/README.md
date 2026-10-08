# @wcvm/sdk

Embed the wcvm Studio editor (Monaco + file tree + terminal + live preview, all running in the
visitor's browser) in any website.

```ts
import { embed } from "@wcvm/sdk";

const vm = await embed("#editor", {
  title: "demo",
  files: { "index.js": "console.log('hi')", "package.json": '{"name":"demo"}' },
  openFile: "index.js",
  // startCommand: "npm run dev",   // runs after `npm install`, in a visible terminal
}, {
  url: "https://studio.wcvmjs.com/embed", // default
  view: "both",                            // "both" | "editor" | "preview"
  panes: { terminal: true },               // titleBar, activityBar, statusBar, explorer, terminal
  theme: "dark",
  width: "100%",   // CSS length or px number; default fills the container
  height: 600,     // CSS length or px number; default 600px
});

await vm.fs.writeFile("index.js", "console.log('changed')");
const { exitCode, output } = await vm.run("node index.js");
vm.on("previewReady", ({ url }) => console.log(url));
vm.on("fileSaved", ({ path }) => console.log("saved", path));
vm.destroy();
```

## Requirement: the host page must be cross-origin isolated

wcvm needs `SharedArrayBuffer`. A cross-origin iframe only gets it when the page embedding it is
isolated too, so the host page must be served with:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Without them `embed()` rejects after `timeout` ("did not respond"). The iframe gets
`allow="cross-origin-isolated"` automatically.

## Demo

`demo/serve.py` serves a host page on :5180 with the right headers; point it at a running Studio
(`pnpm --filter studio build && pnpm --filter studio preview`, `/embed` on :4173).
