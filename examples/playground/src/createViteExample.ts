// The playground's third example: scaffolds a REAL project with `npm create vite@latest`, not a
// hand-written template like reactExample.ts/vueExample.ts - the direct showcase of wcvm's own
// `npm create`/`npm exec` capability (programs/npm/exec.ts). Shares viteExample.ts's own
// install/run/edit machinery, via its "scaffold" source kind. With the "interactive" checkbox
// checked, it runs create-vite's own REAL prompts (arrow-key menus and all) in a raw terminal
// instead of silently with `--no-interactive` - see viteExample.ts's `scaffoldInteractively` and
// interactiveTerminal.ts for how (checked directly against a real spawn: wcvm's vendored
// `readline.emitKeypressEvents` correctly decodes forwarded arrow-key escape sequences).

import type { IWcvm } from "wcvm";
import { attachViteExample, type IViteExampleHandle } from "./viteExample";

const PROJECT = "/created-app";
const PORT = 5175;

export const attachCreateViteExample = (
  wc: IWcvm,
  elements: {
    runButton: HTMLButtonElement;
    status: HTMLElement;
    editor: HTMLTextAreaElement;
    writeToTerminal?: (text: string) => void;
    onBeforeStart?: () => void;
    /** Checked once per run (not just at attach time) to decide silent vs. real-prompt mode. */
    interactiveCheckbox: HTMLInputElement;
    /** Where create-vite's own real interactive prompts are shown, when `interactiveCheckbox` is
     *  checked - empty otherwise. */
    interactiveTerminal: HTMLElement;
  },
): IViteExampleHandle =>
  attachViteExample(
    wc,
    {
      project: PROJECT,
      port: PORT,
      name: "Create Vite",
      editablePath: "src/App.tsx",
      source: {
        kind: "scaffold",
        template: "react-ts",
        pin: { vite: "7.3.6", "@vitejs/plugin-react": "^5.0.0" },
        placeholder: '// click "run Create Vite example" - this scaffolds a REAL project here with\n// `npm create vite@latest -- --template react-ts`, then shows its actual src/App.tsx\n// (check "interactive" first to answer create-vite\'s own real prompts yourself)\n',
      },
    },
    {
      runButton: elements.runButton,
      status: elements.status,
      editor: elements.editor,
      writeToTerminal: elements.writeToTerminal,
      onBeforeStart: elements.onBeforeStart,
      interactiveScaffold: { container: elements.interactiveTerminal, interactive: () => elements.interactiveCheckbox.checked },
    },
  );
