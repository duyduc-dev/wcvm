import { boot } from "wcvm";
import { attachPreview } from "./preview";
import { attachTerminal } from "./terminal";

const wc = boot();

wc.diagnostics.onEvent((event) => {
  console.log(`[${event.timestamp}] ${event.type}`, event.payload);
});

// Exposed for the Playwright e2e and for poking around in DevTools.
(window as unknown as { wc: typeof wc }).wc = wc;

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
} catch (error) {
  if (app) app.textContent = `wcvm failed: ${(error as Error).message}`;
}
