// Wires wc.preview's onListen() event to an iframe pane: no polling, no manual refresh button -
// the moment a guest script's http.createServer().listen() succeeds, the iframe points at it.

import type { IWcvm } from "wcvm";

export const attachPreview = (
  wc: IWcvm,
  elements: { enableButton: HTMLButtonElement; status: HTMLElement; frame: HTMLIFrameElement },
) => {
  const { enableButton, status, frame } = elements;
  let activePort: number | undefined;

  const render = () => {
    status.textContent =
      activePort === undefined
        ? "Enabled. Waiting for a script to listen on a port..."
        : `Previewing virtual port ${activePort}.`;
  };

  enableButton.addEventListener("click", async () => {
    enableButton.disabled = true;
    enableButton.textContent = "enabling...";
    try {
      await wc.preview.enable();
      enableButton.textContent = "preview enabled";
      wc.preview.onListen(({ port, listening }) => {
        if (listening) {
          activePort = port;
          frame.src = wc.preview.url(port);
        } else if (activePort === port) {
          activePort = undefined;
          frame.src = "about:blank";
        }
        render();
      });
      render();
    } catch (error) {
      enableButton.textContent = "enable preview";
      enableButton.disabled = false;
      status.textContent = `Failed to enable preview: ${(error as Error).message}`;
    }
  });
};
