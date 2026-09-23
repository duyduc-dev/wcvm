import { boot } from "wcvm";
import { attachExampleServer } from "./exampleServer";
import { attachPreview } from "./preview";
import { attachTerminal } from "./terminal";

const wc = boot();

wc.diagnostics.onEvent((event) => {
  console.log(`[${event.timestamp}] ${event.type}`, event.payload);
});

// Exposed for the Playwright e2e and for poking around in DevTools. `boot` itself, not just this
// page's own default (no-persist) instance, so a test can create an independently-configured one
// (e.g. `wcvmBoot({ persist: { root: "..." } })`) without disturbing this one.
(window as unknown as { wc: typeof wc; wcvmBoot: typeof boot }).wc = wc;
(window as unknown as { wc: typeof wc; wcvmBoot: typeof boot }).wcvmBoot = boot;

const app = document.querySelector("#app");
if (app) app.textContent = "wcvm playground";

try {
  await wc.ready;
  if (app) app.textContent = "wcvm ready";

  const terminalEl = document.querySelector<HTMLElement>("#terminal");
  const select = document.querySelector<HTMLSelectElement>("#program");
  const restart = document.querySelector<HTMLButtonElement>("#restart");
  if (terminalEl && select && restart) {
    let session: Awaited<ReturnType<typeof attachTerminal>> | undefined;
    const start = async () => {
      session?.stop();
      session = await attachTerminal(wc, terminalEl, select.value);
    };
    select.addEventListener("change", start);
    restart.addEventListener("click", start);
    await start();
  }

  const previewEnable = document.querySelector<HTMLButtonElement>("#preview-enable");
  const previewStatus = document.querySelector<HTMLElement>("#preview-status");
  const previewFrame = document.querySelector<HTMLIFrameElement>("#preview-frame");
  if (previewEnable && previewStatus && previewFrame) {
    attachPreview(wc, { enableButton: previewEnable, status: previewStatus, frame: previewFrame });
  }

  const exampleRun = document.querySelector<HTMLButtonElement>("#example-run");
  const exampleStatus = document.querySelector<HTMLElement>("#example-status");
  const exampleSource = document.querySelector<HTMLElement>("#example-source");
  if (exampleRun && exampleStatus && exampleSource) {
    attachExampleServer(wc, { runButton: exampleRun, status: exampleStatus, source: exampleSource });
  }
} catch (error) {
  if (app) app.textContent = `wcvm failed: ${(error as Error).message}`;
}
