import type * as Monaco from "monaco-editor";
import { EDITOR_FONT_FAMILY, LANGUAGE_BY_EXTENSION } from "./constants";
import { extensionOf } from "./fs.service";
import { registerFormatters } from "./format.service";
import { registerExtraLanguages } from "./languages";
import { registerProjectCompletions } from "./completions.service";
import { registerTemplateCompletions } from "./templates";
import { configureTypescript, invalidateSyncedPath, isProjectSource } from "./typescript.service";

export const languageForPath = (path: string): string =>
  LANGUAGE_BY_EXTENSION[extensionOf(path)] ?? "plaintext";

let monacoPromise: Promise<typeof Monaco> | null = null;

/** Wires Monaco's own web workers (real language services — completions, hover, diagnostics —
 * run off-main-thread) and loads the editor itself; must run exactly once per page, before the
 * first `monaco.editor.create`. Each worker is created from a `new URL(..., import.meta.url)` —
 * Vite's own asset-URL analysis bundles the referenced file into a same-origin chunk (COEP-safe)
 * — rather than the `?worker` query suffix: this project's Vite 8/Rolldown build can't resolve
 * that suffix on a package deep-import (a Rolldown gap, not a monaco-editor one; see PLAN.md's
 * own notes on Vite 8/Rolldown compatibility gaps in packages/core). Each `new URL(...)` call
 * needs a literal string, not a shared helper taking a variable path — Vite's static analysis
 * (which is what turns this into a bundled, same-origin chunk at build time) can't follow one. */
async function loadMonaco(): Promise<typeof Monaco> {
  self.MonacoEnvironment = {
    getWorker(_workerId: string, label: string): Worker {
      switch (label) {
        case "typescript":
        case "javascript":
          return new Worker(new URL("../../../../../node_modules/monaco-editor/esm/vs/language/typescript/ts.worker.js", import.meta.url), { type: "module" });
        case "json":
          return new Worker(new URL("../../../../../node_modules/monaco-editor/esm/vs/language/json/json.worker.js", import.meta.url), { type: "module" });
        case "css":
        case "scss":
        case "less":
          return new Worker(new URL("../../../../../node_modules/monaco-editor/esm/vs/language/css/css.worker.js", import.meta.url), { type: "module" });
        case "html":
        case "handlebars":
        case "razor":
          return new Worker(new URL("../../../../../node_modules/monaco-editor/esm/vs/language/html/html.worker.js", import.meta.url), { type: "module" });
        default:
          return new Worker(new URL("../../../../../node_modules/monaco-editor/esm/vs/editor/editor.worker.js", import.meta.url), { type: "module" });
      }
    },
  };
  const monaco = await import("monaco-editor");
  await registerExtraLanguages(monaco);
  registerFormatters(monaco);
  configureTypescript(monaco);
  registerProjectCompletions(monaco);
  registerTemplateCompletions(monaco);
  return monaco;
}

/** Memoized: every editor host (there's only ever one in v1, but this stays safe if that
 * changes) shares the same Monaco instance and worker wiring. */
export function ensureMonaco(): Promise<typeof Monaco> {
  return (monacoPromise ??= loadMonaco());
}

export function createEditor(
  monaco: typeof Monaco,
  el: HTMLElement,
  isDark: boolean,
): Monaco.editor.IStandaloneCodeEditor {
  return monaco.editor.create(el, {
    model: null,
    theme: isDark ? "vs-dark" : "vs",
    automaticLayout: true,
    fontSize: 13,
    fontFamily: EDITOR_FONT_FAMILY,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    tabSize: 2,
    lineNumbersMinChars: 3,
    // Monaco >=0.56 defaults to `editContext: true` in Chromium (a `div.native-edit-context`
    // instead of the classic hidden textarea) — a known upstream bug in that path silently
    // drops the Space key. Falling back to the textarea-based input avoids it.
    editContext: false,
  });
}

export function getOrCreateModel(
  monaco: typeof Monaco,
  models: Map<string, Monaco.editor.ITextModel>,
  path: string,
  contents: string,
): Monaco.editor.ITextModel {
  const existing = models.get(path);
  if (existing) return existing;
  // A project source file already has a background model (typescript.service.ts) so the language
  // service can resolve imports of it - adopt that one instead of creating a second at the same URI.
  const uri = monaco.Uri.file(path);
  const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(contents, languageForPath(path), uri);
  if (model.getValue() !== contents) model.setValue(contents);
  models.set(path, model);
  return model;
}

export function disposeModel(models: Map<string, Monaco.editor.ITextModel>, path: string): void {
  const model = models.get(path);
  models.delete(path);
  if (!model) return;
  if (isProjectSource(path)) {
    // Closing a tab must not make the file vanish from the language service: keep the model as a
    // background one and have the next project sync re-read it from disk (discarding any unsaved edits).
    invalidateSyncedPath(path);
    return;
  }
  model.dispose();
}

export function renameModel(
  monaco: typeof Monaco,
  models: Map<string, Monaco.editor.ITextModel>,
  from: string,
  to: string,
): void {
  const model = models.get(from);
  if (!model) return;
  models.delete(from);
  const renamed = monaco.editor.createModel(model.getValue(), languageForPath(to), monaco.Uri.file(to));
  models.set(to, renamed);
  model.dispose();
}
