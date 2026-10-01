import type * as Monaco from "monaco-editor";
import { getProjectContext, getTypedPackages, getTypingsVersion, onTypingsChange } from "./typescript.service";

// Auto-import for packages (`OnInit` from "@angular/core", `useState` from "react", ...). The names a
// package exports are not in any model's text - they live in its `.d.ts` graph, behind chains of
// `export * from` / `export { x } from` - so a regex like the one used for project files would miss
// most of them. The TS worker already knows: asking for completions INSIDE the braces of
// `import { | } from "pkg"` returns every export of the module. That is done once per package, in a
// hidden scratch model, and cached until the dependency typings are reloaded.

export interface IPackageExport {
  name: string;
  kind: string;
}

interface ITsEntry {
  name: string;
  kind: string;
}

const MAX_PACKAGES = 60;
const cache = new Map<string, IPackageExport[]>();
let cachedVersion = -1;
let loading: Promise<void> | null = null;
let scratch: Monaco.editor.ITextModel | null = null;

onTypingsChange(() => {
  cache.clear();
  cachedVersion = -1;
});

async function exportsOfPackage(monaco: typeof Monaco, pkg: string): Promise<IPackageExport[]> {
  const ctx = getProjectContext();
  if (!ctx) return [];
  // Under node_modules so the project-source sync never mistakes it for a user file; module
  // resolution from there still walks up to the project's own node_modules.
  const uri = monaco.Uri.file(`${ctx.rootPath}/node_modules/.wcvm/exports.ts`);
  const prefix = "import { ";
  const text = `${prefix} } from ${JSON.stringify(pkg)};`;
  scratch ??= monaco.editor.getModel(uri) ?? monaco.editor.createModel(text, "typescript", uri);
  scratch.setValue(text);
  const getWorker = await monaco.typescript.getTypeScriptWorker();
  const worker = await getWorker(uri);
  const info = (await worker.getCompletionsAtPosition(uri.toString(), prefix.length)) as { entries: ITsEntry[] } | undefined;
  return (info?.entries ?? []).filter((e) => /^[A-Za-z_$][\w$]*$/.test(e.name) && e.kind !== "keyword").map((e) => ({ name: e.name, kind: e.kind }));
}

/** Reads the exports of every typed dependency, once per typings version. Safe to call often: a
 * call during a run waits for it, and one made after the typings were reloaded starts a fresh run. */
export async function warmPackageExports(monaco: typeof Monaco): Promise<void> {
  for (;;) {
    const version = getTypingsVersion();
    if (loading) {
      await loading.catch(() => {});
      continue;
    }
    if (cachedVersion === version) return;
    cachedVersion = version;
    const run = (async () => {
      for (const pkg of getTypedPackages().slice(0, MAX_PACKAGES)) {
        if (cachedVersion !== version) return; // typings reloaded meanwhile - the next run redoes it
        if (!cache.has(pkg)) cache.set(pkg, await exportsOfPackage(monaco, pkg).catch(() => []));
      }
    })();
    // Not a try/finally inside the async body: with nothing to read it would finish synchronously,
    // clearing `loading` BEFORE it is assigned here, and leave it set forever.
    loading = run.finally(() => {
      loading = null;
    });
  }
}

/** Exports per package, as far as they are known now. Waits briefly for a cold cache so the first
 * completion after startup isn't empty, but never blocks the editor for long. */
export async function getPackageExports(monaco: typeof Monaco, waitMs = 1500): Promise<ReadonlyMap<string, IPackageExport[]>> {
  const run = warmPackageExports(monaco);
  await Promise.race([run, new Promise<void>((resolve) => setTimeout(resolve, waitMs))]);
  return cache;
}
