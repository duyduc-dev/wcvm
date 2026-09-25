// Generic "one-click Vite example" wiring, shared by reactExample.ts/vueExample.ts (a static,
// hand-written template) and createViteExample.ts (a REAL `npm create vite@latest` scaffold) -
// the only things that differ between them are the project's own files/editor file/port and how
// the project's very first files get there; installing from the real registry with wcvm's own
// npm, starting Vite via `npm run dev`, and hooking the running project up to the editor and the
// shared preview pane is identical either way. Extracted once a second framework (Vue) needed the
// exact same machinery; grown a second `source` kind once a real `npm create` needed it too.

import type { FileSystemTree, IWcvm } from "wcvm";
import { attachInteractiveTerminal } from "./interactiveTerminal";

export interface IViteExampleConfig {
  /** The project's own directory in the VFS, e.g. "/react-app". */
  project: string;
  /** This example's own virtual port - every example needs a distinct one, since they can run
   *  at the same time as far as wcvm itself is concerned (only the single shared preview pane
   *  makes them mutually exclusive in this UI - see `onBeforeStart`, below). */
  port: number;
  /** Shown as "run <name> example"/"stop <name> example" and in the installing status line. */
  name: string;
  /** Path relative to `project` of the file the editor edits, e.g. "src/App.tsx". */
  editablePath: string;
  /** How the project's own files get there on the FIRST run (never repeated on a later
   *  stop/start cycle - only `editablePath`'s own current content is rewritten every time, same
   *  as any other edit). */
  source:
    | {
        kind: "static";
        /** Every project file except `editablePath` itself (that one's own initial content is
         *  `initialContent`, written from the editor itself so an edit made before the first run
         *  is never lost). */
        files: Record<string, string>;
        initialContent: string;
      }
    | {
        kind: "scaffold";
        /** A real `create-vite` template name, e.g. "react-ts"/"vue-ts". */
        template: string;
        /** devDependency versions to pin AFTER scaffolding, overriding whatever
         *  `create-vite@latest`'s own CURRENT template picked - it moves independently of this
         *  sandbox's own wasm-swappable Vite 7/Rollup/esbuild pins (see CLAUDE.md's "Status" for
         *  two real version-mismatch gotchas this found: `create-vite@latest` currently
         *  scaffolds Vite 8/Rolldown, which has no wasm build here, and its own
         *  `@vitejs/plugin-react` expects newer export paths than Vite 7 has). */
        pin: Record<string, string>;
        /** Shown in the editor before the first run, when there's no real file to show yet. */
        placeholder: string;
      };
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

/** Strips ANSI SGR escape codes (`\x1b[...m`) from a copy of the text used only for substring
 *  checks/display, never from what's actually shown in the terminal (the whole point of turning
 *  color on there). Real Vite's own colorized banner literally prints "Local\x1b[22m:", not
 *  "Local:" - picocolors wraps just the WORD "Local" in bold, with the punctuation appended after
 *  the closing code - so a plain `/Local:/` check silently stops matching once color is on unless
 *  it runs against a stripped copy first (found by an actual hang: `npm run dev` with FORCE_COLOR
 *  set really did start Vite - the raw log had a real "Local:" line - `/Local:/.test(log)` just
 *  never saw it as one contiguous substring). */
const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

/** Turns a flat "relative/path": "contents" map (much simpler for a framework's own example to
 *  author than a nested tree literal) into the nested `FileSystemTree` `wc.fs.mount()` needs -
 *  one call that writes the whole project in a single round trip, instead of a
 *  mkdir()+writeFile() pair per file each going through the host<->kernel bridge on its own. */
const buildTree = (files: Record<string, string>): FileSystemTree => {
  const root: FileSystemTree = {};
  for (const [path, contents] of Object.entries(files)) {
    const parts = path.split("/");
    let dir = root;
    for (const segment of parts.slice(0, -1)) {
      const existing = dir[segment];
      const node = existing && "directory" in existing ? existing : { directory: {} };
      dir[segment] = node;
      dir = node.directory;
    }
    dir[parts.at(-1)!] = { file: { contents } };
  }
  return root;
};

/** Esbuild/Rollup's native binaries can't run in a browser - swapped for their WebAssembly
 *  builds, same as the hand-written React/Vue examples' own package.json literals already do. */
const WASM_OVERRIDES = { esbuild: "npm:esbuild-wasm@0.28.2", rollup: "npm:@rollup/wasm-node@4.63.4" };

/** Scaffolds a REAL project with `npm create vite@latest` (see `IViteExampleConfig`'s "scaffold"
 *  source kind for why the pin+overrides below are needed), then returns the real content of its
 *  own `editablePath` to seed the editor with. */
const scaffoldWithNpmCreate = async (
  wc: IWcvm,
  project: string,
  editablePath: string,
  source: Extract<IViteExampleConfig["source"], { kind: "scaffold" }>,
  writeToTerminal: ((text: string) => void) | undefined,
): Promise<string> => {
  // `project` is this example's own absolute VFS path (e.g. "/created-app") - create-vite's own
  // target-directory argument is relative to ITS cwd, so spawn from "/" with the leading slash
  // stripped; `path.join("/", ...)` inside create-vite's own code then lands back on `project`.
  const created = await wc.spawn("npm", ["create", "vite@latest", project.slice(1), "--", "--template", source.template, "--no-interactive"], { cwd: "/", env: { FORCE_COLOR: "3" } });
  let createdLog = "";
  collect(created, (text) => (createdLog += text), writeToTerminal);
  const exit = await created.exit;
  if (exit.exitCode !== 0) throw new Error(`npm create vite failed:\n${stripAnsi(createdLog).trim()}`);

  const pkgPath = `${project}/package.json`;
  const pkg = JSON.parse(new TextDecoder().decode(await wc.fs.readFile(pkgPath)));
  Object.assign(pkg.devDependencies, source.pin);
  pkg.overrides = WASM_OVERRIDES;
  await wc.fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2));

  return new TextDecoder().decode(await wc.fs.readFile(`${project}/${editablePath}`));
};

/** The version pins interactive mode can apply with confidence - it doesn't know ahead of time
 *  which framework the user will actually pick from create-vite's own real prompts, unlike the
 *  non-interactive path's own `source.pin` (chosen for one specific, already-known template).
 *  `vite` itself is always safe to pin (fixes Vite 8/Rolldown's wasm trap regardless of
 *  framework); a plugin is only pinned if the scaffolded project actually depends on it. */
const KNOWN_PLUGIN_PINS: Record<string, string> = { "@vitejs/plugin-react": "^5.0.0", "@vitejs/plugin-vue": "^6.0.0" };

/** A real create-vite template's own editable "App" file isn't always `src/App.tsx` - try the
 *  configured default first, then every other common convention its OTHER templates use, so
 *  picking a different framework interactively still seeds the editor with something real
 *  instead of failing outright. `undefined` if truly nothing recognizable was found (the user
 *  picked a template - "Others", a custom starter - this sandbox has no seeded guess for at all;
 *  the project still exists on disk, just not wired to this editor). */
const EDITABLE_CANDIDATES = ["src/App.tsx", "src/App.vue", "src/App.svelte", "src/App.jsx", "src/app.tsx", "src/App.js"];
const findEditableFile = async (wc: IWcvm, project: string, preferred: string): Promise<{ path: string; content: string } | undefined> => {
  for (const candidate of [preferred, ...EDITABLE_CANDIDATES]) {
    try {
      return { path: candidate, content: new TextDecoder().decode(await wc.fs.readFile(`${project}/${candidate}`)) };
    } catch {
      // not this one - try the next
    }
  }
  return undefined;
};

/** Scaffolds with create-vite's own REAL interactive prompts (arrow-key menus and all) in a raw
 *  terminal shown in `container`, instead of running silently with `--no-interactive` - the
 *  target directory is still given explicitly (skips only the "Project name?" prompt, so the
 *  result always lands at `project`), and `--no-immediate` skips create-vite's own "install and
 *  start now?" prompt: it would run `npm run dev` SYNCHRONOUSLY inside create-vite's own process
 *  if answered yes, which never returns for a dev server - installing/starting is already this
 *  example's own next step, asynchronously, the normal wcvm way. Returns the real content of
 *  whatever editable file was actually found (see `findEditableFile`) - its OWN real path, since
 *  it isn't necessarily `editablePath` once the framework choice is genuinely free - or `undefined`
 *  if none was recognized. */
const scaffoldInteractively = async (
  wc: IWcvm,
  project: string,
  editablePath: string,
  container: HTMLElement,
): Promise<{ path: string; content: string } | undefined> => {
  const proc = await wc.spawn("npm", ["create", "vite@latest", project.slice(1), "--", "--interactive", "--no-immediate"], { cwd: "/", env: { FORCE_COLOR: "3" } });
  const term = attachInteractiveTerminal(container, proc);
  const exit = await proc.exit;
  term.stop();
  if (exit.exitCode !== 0) throw new Error(`npm create vite (interactive) exited with code ${exit.exitCode}`);

  const pkgPath = `${project}/package.json`;
  const pkg = JSON.parse(new TextDecoder().decode(await wc.fs.readFile(pkgPath)));
  pkg.devDependencies ??= {};

  // The "React Compiler" variant (real, found by actually picking it - see CLAUDE.md's "Status")
  // needs @vitejs/plugin-react 6+ for its own reactCompilerPreset export (added exactly at 6.0.0,
  // absent from every 5.x - checked directly against the published packages), but 6.x itself
  // imports from the "vite/internal" subpath, which vite@7.3.6 doesn't export at all (only
  // vite@8+ does - and vite@8 defaults to Rolldown, which has no wasm build here - see the
  // "scaffold" source kind's own doc comment). There's no vite/plugin-react pair this sandbox can
  // run for this ONE variant - fail clearly now, before wasting an install on a project that can
  // only ever crash the same way starting its dev server would.
  if (pkg.devDependencies["babel-plugin-react-compiler"]) {
    throw new Error(
      'The "React Compiler" variant needs @vitejs/plugin-react 6+, which itself needs a newer Vite than this sandbox can run yet (Vite 8\'s own default bundler, Rolldown, has no WebAssembly build here) - pick a plain "TypeScript"/"JavaScript" variant instead.',
    );
  }

  pkg.devDependencies.vite = "7.3.6";
  for (const [name, pin] of Object.entries(KNOWN_PLUGIN_PINS)) if (pkg.devDependencies[name]) pkg.devDependencies[name] = pin;
  pkg.overrides = WASM_OVERRIDES;
  await wc.fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2));

  return findEditableFile(wc, project, editablePath);
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
    /** Only meaningful for a "scaffold" source: a place to show create-vite's own REAL
     *  interactive prompts, and a live check of whether to use them at all (a checkbox, say) -
     *  read once at the start of each run, not just once at attach time. Omitted (or `interactive()`
     *  false) keeps the existing silent `--no-interactive` behavior. */
    interactiveScaffold?: { container: HTMLElement; interactive(): boolean };
  },
): IViteExampleHandle => {
  const { runButton, status, editor, writeToTerminal, onBeforeStart, interactiveScaffold } = elements;
  editor.value = config.source.kind === "static" ? config.source.initialContent : config.source.placeholder;

  let vite: Process | undefined;
  let projectWritten = false;
  // Not necessarily `config.editablePath` once interactive mode's framework choice is genuinely
  // free - see `findEditableFile`.
  let editablePath = config.editablePath;

  const writeEditable = () => wc.fs.writeFile(`${config.project}/${editablePath}`, editor.value);

  // Every edit lands in the running project; Vite's watcher picks it up and hot-updates it.
  let pending: ReturnType<typeof setTimeout> | undefined;
  editor.addEventListener("input", () => {
    if (!projectWritten) return; // used as the starting content on the next run instead
    clearTimeout(pending);
    pending = setTimeout(() => void writeEditable(), 250);
  });

  /** Always updates the UI to report a failure, whether or not `vite` was ever assigned - a
   *  scaffold or npm install failure happens well before `npm run dev` is even spawned. Unlike
   *  `stop`, which is guarded so a cross-example "stop yourself" call is a safe no-op when this
   *  example isn't running (found the hard way: that guard was ALSO silently swallowing this
   *  example's own start() failures, since `vite` isn't set yet when one of those happens - the
   *  status just froze on "Scaffolding..."/"Installing..." forever instead of ever showing why). */
  const reportFailure = (message: string) => {
    vite?.kill();
    vite = undefined;
    runButton.textContent = `run ${config.name} example`;
    status.textContent = message;
  };

  const stop = (message: string) => {
    if (!vite) return; // nothing running - e.g. another example's onBeforeStart calling this one
    reportFailure(message);
  };

  const start = async () => {
    onBeforeStart?.();
    await wc.preview.enable();

    if (!projectWritten) {
      if (config.source.kind === "scaffold") {
        if (interactiveScaffold?.interactive()) {
          status.textContent = "Scaffolding interactively - answer create-vite's own real prompts in the terminal below...";
          const found = await scaffoldInteractively(wc, config.project, config.editablePath, interactiveScaffold.container);
          if (found) {
            editablePath = found.path;
            editor.value = found.content;
          } else {
            status.textContent = "Scaffolded, but couldn't find a recognized component file to edit live here - the project is still on disk.";
          }
        } else {
          status.textContent = `Scaffolding a real project with npm create vite@latest -- --template ${config.source.template} (~5s)...`;
          editor.value = await scaffoldWithNpmCreate(wc, config.project, config.editablePath, config.source, writeToTerminal);
        }
      } else {
        await wc.fs.mount(buildTree(config.source.files), config.project);
      }
      projectWritten = true;
    }
    await writeEditable();

    // FORCE_COLOR: real npm's own output has none (plain string literals - see runScript.ts),
    // but it flows through to `npm run dev`'s own child (real Node/Vite) unchanged, so Vite's
    // colorful startup banner shows up in real color in the shared terminal pane it's mirrored
    // into below - the same reason terminal.ts's own interactive session sets it.
    status.textContent = `Installing ${config.name}, Vite and friends from registry.npmjs.org with wcvm's npm install (~10s the first time)...`;
    const install = await wc.spawn("npm", ["install"], { cwd: config.project, env: { FORCE_COLOR: "3" } });
    let installLog = "";
    collect(install, (text) => (installLog += text), writeToTerminal);
    const installed = await install.exit;
    if (installed.exitCode !== 0) throw new Error(`npm install failed:\n${installLog.trim()}`);

    status.textContent = `${installLog.trim()} - starting Vite...`;
    // `npm run dev` (package.json's own "dev": "vite") rather than invoking vite.js directly -
    // exercises wcvm's own npm run, including its PATH-resolved `vite` bin.
    const started = await wc.spawn("npm", ["run", "dev", "--", "--port", String(config.port), "--strictPort"], { cwd: config.project, env: { FORCE_COLOR: "3" } });
    vite = started;
    runButton.textContent = `stop ${config.name} example`;
    let log = "";
    collect(started, (text) => {
      log += text;
      if (/Local:/.test(stripAnsi(log)) && vite === started) {
        status.textContent = `Vite is running on virtual port ${config.port} - the app is in the preview pane below. Edit ${editablePath} here and watch it hot-reload.`;
      }
    }, writeToTerminal);
    started.exit.then((result) => {
      if (vite !== started) return; // already stopped (or restarted) by the user
      stop(`Vite exited unexpectedly (code ${result.exitCode}):\n${stripAnsi(log).trim().split("\n").slice(-5).join("\n")}`);
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
      reportFailure(`Failed to start: ${(error as Error).message}`);
    } finally {
      runButton.disabled = false;
    }
  });

  return { stop };
};
