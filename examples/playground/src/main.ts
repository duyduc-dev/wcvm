import { boot } from "wcvm";
import { attachTerminal } from "./terminal";

const wc = boot();

wc.diagnostics.onEvent((event) => {
  console.log(`[${event.timestamp}] ${event.type}`, event.payload);
});

// Exposed for the Playwright e2e and for poking around in DevTools.
(window as unknown as { wc: typeof wc }).wc = wc;

const app = document.querySelector("#app");
if (app) app.textContent = "wcvm playground";

wc.ready.then(
  async () => {
    if (app) app.textContent = "wcvm ready";

    const terminalEl = document.querySelector<HTMLElement>("#terminal");
    const select = document.querySelector<HTMLSelectElement>("#program");
    const restart = document.querySelector<HTMLButtonElement>("#restart");
    if (!terminalEl || !select || !restart) return;

    let session: Awaited<ReturnType<typeof attachTerminal>> | undefined;
    const start = async () => {
      session?.stop();
      session = await attachTerminal(wc, terminalEl, select.value);
    };
    select.addEventListener("change", start);
    restart.addEventListener("click", start);
    await start();
  },
  (error: Error) => app && (app.textContent = `wcvm failed: ${error.message}`),
);
