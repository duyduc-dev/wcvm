import { boot } from "wcvm";
import { attachCreateViteExample } from "./createViteExample";
import { attachPreview } from "./preview";
import { attachReactExample } from "./reactExample";
import { attachTerminal } from "./terminal";
import type { IViteExampleHandle } from "./viteExample";
import { attachVueExample } from "./vueExample";

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

  // Referenced by the React example below too, so its own npm/vite output can be mirrored into
  // whichever session is live right now - reassigned on every restart/program switch.
  let session: Awaited<ReturnType<typeof attachTerminal>> | undefined;

  const terminalEl = document.querySelector<HTMLElement>("#terminal");
  const select = document.querySelector<HTMLSelectElement>("#program");
  const restart = document.querySelector<HTMLButtonElement>("#restart");
  if (terminalEl && select && restart) {
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

  // All three examples share the one preview pane above, so only one of their dev servers should
  // ever be listening at a time - starting any one of them stops the other two first
  // (`onBeforeStart`); `stop()` itself is a no-op for one that isn't running.
  let reactExample: IViteExampleHandle | undefined;
  let vueExample: IViteExampleHandle | undefined;
  let createExample: IViteExampleHandle | undefined;

  const exampleRun = document.querySelector<HTMLButtonElement>("#example-run");
  const exampleStatus = document.querySelector<HTMLElement>("#example-status");
  const exampleEditor = document.querySelector<HTMLTextAreaElement>("#example-editor");
  if (exampleRun && exampleStatus && exampleEditor) {
    reactExample = attachReactExample(wc, {
      runButton: exampleRun,
      status: exampleStatus,
      editor: exampleEditor,
      writeToTerminal: (text) => session?.write(text),
      onBeforeStart: () => {
        vueExample?.stop("Stopped (switched to the React example).");
        createExample?.stop("Stopped (switched to the React example).");
      },
    });
  }

  const exampleVueRun = document.querySelector<HTMLButtonElement>("#example-vue-run");
  const exampleVueStatus = document.querySelector<HTMLElement>("#example-vue-status");
  const exampleVueEditor = document.querySelector<HTMLTextAreaElement>("#example-vue-editor");
  if (exampleVueRun && exampleVueStatus && exampleVueEditor) {
    vueExample = attachVueExample(wc, {
      runButton: exampleVueRun,
      status: exampleVueStatus,
      editor: exampleVueEditor,
      writeToTerminal: (text) => session?.write(text),
      onBeforeStart: () => {
        reactExample?.stop("Stopped (switched to the Vue example).");
        createExample?.stop("Stopped (switched to the Vue example).");
      },
    });
  }

  const exampleCreateRun = document.querySelector<HTMLButtonElement>("#example-create-run");
  const exampleCreateStatus = document.querySelector<HTMLElement>("#example-create-status");
  const exampleCreateEditor = document.querySelector<HTMLTextAreaElement>("#example-create-editor");
  const exampleCreateInteractive = document.querySelector<HTMLInputElement>("#example-create-interactive");
  const exampleCreateTerminal = document.querySelector<HTMLElement>("#example-create-terminal");
  if (exampleCreateRun && exampleCreateStatus && exampleCreateEditor && exampleCreateInteractive && exampleCreateTerminal) {
    createExample = attachCreateViteExample(wc, {
      runButton: exampleCreateRun,
      status: exampleCreateStatus,
      editor: exampleCreateEditor,
      writeToTerminal: (text) => session?.write(text),
      interactiveCheckbox: exampleCreateInteractive,
      interactiveTerminal: exampleCreateTerminal,
      onBeforeStart: () => {
        reactExample?.stop("Stopped (switched to the Create Vite example).");
        vueExample?.stop("Stopped (switched to the Create Vite example).");
      },
    });
  }
} catch (error) {
  if (app) app.textContent = `wcvm failed: ${(error as Error).message}`;
}
