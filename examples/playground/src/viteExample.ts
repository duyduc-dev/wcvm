// Generic "one-click Vite example" wiring, shared by reactExample.ts and vueExample.ts (the only
// thing that differs between a framework's example is its own project files/editor file/port -
// installing from the real registry with wcvm's own npm, starting Vite via `npm run dev`, and
// hooking the running project up to the editor and the shared preview pane is identical either
// way). Extracted once a second framework (Vue) needed the exact same machinery.

import type { IWcvm } from "wcvm";

export interface IViteExampleConfig {
  /** The project's own directory in the VFS, e.g. "/react-app". */
  project: string;
  /** This example's own virtual port - every example needs a distinct one, since they can run
   *  at the same time as far as wcvm itself is concerned (only the single shared preview pane
   *  makes them mutually exclusive in this UI - see `onBeforeStart`, below). */
  port: number;
  /** Shown as "run <name> example"/"stop <name> example" and in the installing status line. */
  name: string;
  /** Every project file except the one the editor edits live (that one's own initial content is
   *  `initialContent`, written from the editor itself so an edit made before the first run is
   *  never lost). */
  files: Record<string, string>;
  /** Path relative to `project` of the file the editor edits, e.g. "src/App.tsx". */
  editablePath: string;
  initialContent: string;
}

type Process = Awaited<ReturnType<IWcvm["spawn"]>>;

/** Everything a process writes, as text, as it arrives - also mirrored into the shared terminal
 *  pane (if one's attached), interleaved with whatever that session is doing, so npm install's
 *  and Vite's own output (including its ongoing HMR log lines) are visible somewhere in full,
 *  not just the one-line status text derived from them. */
const collect = (proc: Process, onText: (text: string) => void, writeToTerminal?: (text: string) => void) => {
  for (const stream of [proc.stdout, proc.stderr]) {
    void (async () => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        const text = decoder.decode(value);
        onText(text);
        writeToTerminal?.(text);
      }
    })();
  }
};

export interface IViteExampleHandle {
  /** Stops this example's dev server, if running, with the given status message - used by
   *  another example sharing the same preview pane to make the two mutually exclusive. */
  stop(message: string): void;
}

export const attachViteExample = (
  wc: IWcvm,
  config: IViteExampleConfig,
  elements: {
    runButton: HTMLButtonElement;
    status: HTMLElement;
    editor: HTMLTextAreaElement;
    /** Mirrors this example's npm/vite output into the shared terminal pane, if one's attached. */
    writeToTerminal?: (text: string) => void;
    /** Called right before this example starts writing/installing/spawning anything - the hook
     *  another example sharing the same preview pane uses to stop itself first. */
    onBeforeStart?: () => void;
  },
): IViteExampleHandle => {
  const { runButton, status, editor, writeToTerminal, onBeforeStart } = elements;
  editor.value = config.initialContent;

  let vite: Process | undefined;
  let projectWritten = false;

  const writeEditable = () => wc.fs.writeFile(`${config.project}/${config.editablePath}`, editor.value);

  // Every edit lands in the running project; Vite's watcher picks it up and hot-updates it.
  let pending: ReturnType<typeof setTimeout> | undefined;
  editor.addEventListener("input", () => {
    if (!projectWritten) return; // used as the starting content on the next run instead
    clearTimeout(pending);
    pending = setTimeout(() => void writeEditable(), 250);
  });

  const stop = (message: string) => {
    if (!vite) return; // nothing running - e.g. another example's onBeforeStart calling this one
    vite.kill();
    vite = undefined;
    runButton.textContent = `run ${config.name} example`;
    status.textContent = message;
  };

  const start = async () => {
    onBeforeStart?.();
    await wc.preview.enable();

    for (const [path, contents] of Object.entries(config.files)) {
      const full = `${config.project}/${path}`;
      await wc.fs.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
      await wc.fs.writeFile(full, contents);
    }
    await writeEditable();
    projectWritten = true;

    status.textContent = `Installing ${config.name}, Vite and friends from registry.npmjs.org with wcvm's npm install (~10s the first time)...`;
    const install = await wc.spawn("npm", ["install"], { cwd: config.project });
    let installLog = "";
    collect(install, (text) => (installLog += text), writeToTerminal);
    const installed = await install.exit;
    if (installed.exitCode !== 0) throw new Error(`npm install failed:\n${installLog.trim()}`);

    status.textContent = `${installLog.trim()} - starting Vite...`;
    // `npm run dev` (package.json's own "dev": "vite") rather than invoking vite.js directly -
    // exercises wcvm's own npm run, including its PATH-resolved `vite` bin.
    const started = await wc.spawn("npm", ["run", "dev", "--", "--port", String(config.port), "--strictPort"], { cwd: config.project });
    vite = started;
    runButton.textContent = `stop ${config.name} example`;
    let log = "";
    collect(started, (text) => {
      log += text;
      if (/Local:/.test(log) && vite === started) {
        status.textContent = `Vite is running on virtual port ${config.port} - the app is in the preview pane below. Edit ${config.editablePath} here and watch it hot-reload.`;
      }
    }, writeToTerminal);
    started.exit.then((result) => {
      if (vite !== started) return; // already stopped (or restarted) by the user
      stop(`Vite exited unexpectedly (code ${result.exitCode}):\n${log.trim().split("\n").slice(-5).join("\n")}`);
    });
  };

  runButton.addEventListener("click", async () => {
    if (vite) {
      stop("Stopped.");
      return;
    }
    runButton.disabled = true;
    status.textContent = "Writing the project...";
    try {
      await start();
    } catch (error) {
      stop(`Failed to start: ${(error as Error).message}`);
    } finally {
      runButton.disabled = false;
    }
  });

  return { stop };
};
