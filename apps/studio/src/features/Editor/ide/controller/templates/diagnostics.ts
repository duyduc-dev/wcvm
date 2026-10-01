import type * as Monaco from "monaco-editor";
import { componentImportEdit, importableComponents, withoutComments } from "./componentImport";
import { scriptBlocks } from "./shadowScript";
import { onComponentFilesChange } from "../typescript.service";

// A Vue / Svelte template that uses `<Counter />` without importing it fails at runtime, but Monaco
// has no checker for these formats, so nothing says so. This marks the tag and offers a quick fix.
//
// Svelte has no global component registry, so any PascalCase tag that the script doesn't mention is
// an error. Vue can register components globally (plugins, `app.component`), so there the error is
// only raised for a tag that matches a `.vue` file in the project - a known, merely un-imported one.

const OWNER = "wcvm-template";
const CODE = "missing-component-import";
const VUE_BUILTINS = new Set(["Transition", "TransitionGroup", "KeepAlive", "Teleport", "Suspense", "Component", "RouterLink", "RouterView", "Slot"]);

const blank = (s: string): string => s.replace(/[^\n]/g, " ");

/** The markup with `<script>`, `<style>` and HTML comments blanked (offsets preserved). */
const markupOnly = (text: string): string =>
  text.replace(/<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi, blank);

const scriptCode = (text: string): string =>
  scriptBlocks(text)
    .map((b) => withoutComments(text.slice(b.start, b.end)))
    .join("\n");

interface IMissing {
  name: string;
  start: number;
}

export function findMissingComponents(text: string, flavor: "vue" | "svelte", path: string): IMissing[] {
  const code = scriptCode(text);
  const known = new Map(importableComponents(path, text).map((c) => [c.name, c]));
  const out: IMissing[] = [];
  for (const m of markupOnly(text).matchAll(/<([A-Z][A-Za-z0-9_$]*)(?=[\s/>])/g)) {
    const name = m[1];
    if (flavor === "vue" && (VUE_BUILTINS.has(name) || !known.has(name))) continue;
    if (new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\b`).test(code)) continue;
    out.push({ name, start: m.index + 1 });
  }
  return out;
}

export function registerTemplateDiagnostics(monaco: typeof Monaco): void {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const flavorOf = (model: Monaco.editor.ITextModel): "vue" | "svelte" | null => {
    const id = model.getLanguageId();
    return id === "vue" || id === "svelte" ? id : null;
  };

  const validate = (model: Monaco.editor.ITextModel): void => {
    const flavor = flavorOf(model);
    if (!flavor || model.isDisposed()) return;
    const path = model.uri.path;
    const known = new Map(importableComponents(path, model.getValue()).map((c) => [c.name, c]));
    const markers: Monaco.editor.IMarkerData[] = findMissingComponents(model.getValue(), flavor, path).map(({ name, start }) => {
      const from = model.getPositionAt(start);
      const to = model.getPositionAt(start + name.length);
      const target = known.get(name);
      return {
        severity: monaco.MarkerSeverity.Error,
        code: CODE,
        source: flavor,
        message: target
          ? `Component '${name}' is not imported. Import it from "${target.spec}".`
          : `Cannot find component '${name}'. Did you forget to import it?`,
        startLineNumber: from.lineNumber,
        startColumn: from.column,
        endLineNumber: to.lineNumber,
        endColumn: to.column,
      };
    });
    monaco.editor.setModelMarkers(model, OWNER, markers);
  };

  const schedule = (model: Monaco.editor.ITextModel, delay = 400): void => {
    const key = model.uri.toString();
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => validate(model), delay));
  };

  const watch = (model: Monaco.editor.ITextModel): void => {
    if (!flavorOf(model)) return;
    schedule(model, 0);
    const sub = model.onDidChangeContent(() => schedule(model));
    model.onWillDispose(() => {
      sub.dispose();
      clearTimeout(timers.get(model.uri.toString()));
      timers.delete(model.uri.toString());
    });
  };

  monaco.editor.getModels().forEach(watch);
  monaco.editor.onDidCreateModel(watch);
  // The set of importable components changed (a file was added/removed): marks may flip.
  onComponentFilesChange(() => monaco.editor.getModels().forEach((m) => flavorOf(m) && schedule(m, 0)));

  for (const language of ["vue", "svelte"] as const) {
    monaco.languages.registerCodeActionProvider(language, {
      provideCodeActions(model, _range, context) {
        const actions: Monaco.languages.CodeAction[] = [];
        for (const marker of context.markers) {
          if (marker.code !== CODE) continue;
          const name = model.getValueInRange(marker);
          const target = importableComponents(model.uri.path, model.getValue()).find((c) => c.name === name);
          if (!target) continue;
          actions.push({
            title: `Import ${name} from "${target.spec}"`,
            kind: "quickfix",
            diagnostics: [marker],
            isPreferred: true,
            edit: { edits: [{ resource: model.uri, versionId: model.getVersionId(), textEdit: componentImportEdit(model, language, target) }] },
          });
        }
        return { actions, dispose: () => {} };
      },
    });
  }
}
