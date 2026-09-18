import { expect, test } from "@playwright/test";

// The whole flow (a real `npm create vite@latest`, pinning the scaffold to
// Vite 8.0.0 + its explicit Rolldown WASI binding and the esbuild-wasm/
// @rollup/wasm-node overrides, a real `npm
// install` against the real registry, `npm run dev`, then a real request
// the guest server actually serves) is a genuine end-to-end run - several
// minutes, not seconds, dominated by the real npm install. The exact pin
// avoids silently moving to a later Rolldown release until it passes this
// full preview flow too; see PROGRESS.md for the WASI compatibility boundary.
test.setTimeout(10 * 60 * 1000);

test("the playground demo scaffolds a real Vite project, installs it, and shows a real, crash-free, interactive dev-server preview (images included)", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/");

  // Scaffolding itself is fast; the real npm install (against the real
  // registry, now installing Vite/Rolldown's explicitly pinned WASI package) is
  // the slow part.
  await expect(page.locator("#terminal")).toContainText("[npm create vite] exit=0", { timeout: 60_000 });
  await expect(page.locator("#terminal")).toContainText("[npm install] exit=0", { timeout: 5 * 60_000 });
  await expect(page.locator("#terminal")).toContainText("[preview] iframe.src ->", { timeout: 3 * 60_000 });

  // Regression guard for the WASI Rolldown lifecycle trap: fail loud and
  // specifically here, not just with a blank iframe further down.
  const terminalText = await page.locator("#terminal").innerText();
  expect(terminalText).not.toContain("RuntimeError");
  expect(terminalText).not.toContain("Cannot find module");

  // The preview iframe is same-origin (both on the Vite dev server's own
  // origin - see previewProtocol.ts), so its document is directly
  // inspectable: real Vite content, not a blank or crashed page.
  await expect
    .poll(async () => page.frame({ url: /__dwc_preview__/ })?.title() ?? null, { timeout: 30_000 })
    .toBe("my-vite-app");

  // At least one real image asset loads correctly - the exact regression
  // this guards against (fs.createReadStream, see PROGRESS.md item 10's
  // own follow-up): before that fix, any image served over HTTP (as
  // opposed to inlined by Vite as a data: URL) 500'd and never rendered.
  await expect
    .poll(
      async () => {
        const frame = page.frame({ url: /__dwc_preview__/ });
        if (!frame) return 0;
        return frame.evaluate(
          () =>
            Array.from(document.querySelectorAll("img")).filter(
              (img) => !img.src.startsWith("data:") && img.complete && img.naturalWidth > 0,
            ).length,
        );
      },
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);

  expect(pageErrors).toEqual([]);

  // Real WebSocket/HMR transport support: the injected polyfill
  // (workers/preview/wsPolyfill.ts) replaces window.WebSocket inside the
  // preview iframe before Vite's own client script runs (a Service Worker
  // can never intercept a page's own `new WebSocket(...)` call - see that
  // file's doc comment) - confirm it's actually installed, and that a
  // WebSocket dialed through it reaches a real, protocol-correct OPEN
  // state via a genuine RFC 6455 handshake against Vite's own bundled WS
  // server (verified manually end-to-end before adding this assertion).
  //
  // This test itself only covers the transport - the actual "edit a file,
  // see a live update" flow (which additionally needs fs.watch to fire real
  // change notifications) is covered separately below, now that fs.watch is
  // real (see PROGRESS.md item 11's own follow-up).
  const frame = page.frame({ url: /__dwc_preview__/ });
  const wsResult = await frame?.evaluate(async () => {
    const anyWindow = window as unknown as { __dwcRealWebSocket?: unknown; WebSocket: new (url: string, protocols?: string | string[]) => WebSocket };
    if (!anyWindow.__dwcRealWebSocket) return { installed: false };

    const ws = new anyWindow.WebSocket("ws://localhost/", "vite-hmr");
    const outcome = await new Promise<string>((resolve) => {
      const timeout = setTimeout(() => resolve(`timeout readyState=${ws.readyState}`), 8000);
      ws.addEventListener("open", () => {
        clearTimeout(timeout);
        resolve(`open protocol=${ws.protocol} readyState=${ws.readyState}`);
      });
      ws.addEventListener("close", (event) => {
        clearTimeout(timeout);
        resolve(`closed code=${event.code}`);
      });
    });
    ws.close();
    return { installed: true, outcome };
  });

  expect(wsResult?.installed).toBe(true);
  expect(wsResult?.outcome).toBe("open protocol=vite-hmr readyState=1");

  // The actual end goal of item 11: a real guest file edit (via dwc.fs,
  // exactly how a host-side code editor would write a change) becomes
  // visible in the live preview, with no reload - real Vite CSS HMR swaps
  // the <style> tag's content in place once it learns (via fs.watch, now
  // real - see runtime/builtins/fs.ts and workers/fs/worker.ts's own watch
  // registry) that /my-vite-app/src/style.css changed. dwc.fs.writeFile() goes
  // through the exact same kernel FS_REQUEST -> FS Worker -> VirtualFileSystem
  // path chokidar's own fs.watch(dir, {recursive}) call is registered
  // against, so this exercises the real, full path end to end - not a
  // shortcut that only proves the transport (the block above) or only the
  // watch registry in isolation (covered by unit tests elsewhere).
  const marker = "rgb(1, 2, 3)";
  const cssPath = "/my-vite-app/src/style.css";
  await page.evaluate(
    async ({ path, markerColor }) => {
      const dwc = (
        window as unknown as {
          dwc: { fs: { readFile(p: string): Promise<Uint8Array>; writeFile(p: string, c: string): Promise<void> } };
        }
      ).dwc;
      const original = new TextDecoder().decode(await dwc.fs.readFile(path));
      await dwc.fs.writeFile(path, `${original}\nbody { background-color: ${markerColor} !important; }\n`);
    },
    { path: cssPath, markerColor: marker },
  );

  await expect
    .poll(
      async () => {
        const liveFrame = page.frame({ url: /__dwc_preview__/ });
        if (!liveFrame) return null;
        return liveFrame.evaluate(() => getComputedStyle(document.body).backgroundColor);
      },
      { timeout: 30_000 },
    )
    .toBe(marker);

  expect(pageErrors).toEqual([]);
});
