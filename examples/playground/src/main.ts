import { boot } from "wcvm";

const wc = boot();

wc.diagnostics.onEvent((event) => {
  console.log(`[${event.timestamp}] ${event.type}`, event.payload);
});

// Exposed for the Playwright e2e and for poking around in DevTools.
(window as unknown as { wc: typeof wc }).wc = wc;

const app = document.querySelector("#app");
if (app) app.textContent = "wcvm playground";

wc.ready.then(
  () => app && (app.textContent = "wcvm ready"),
  (error: Error) => app && (app.textContent = `wcvm failed: ${error.message}`),
);
