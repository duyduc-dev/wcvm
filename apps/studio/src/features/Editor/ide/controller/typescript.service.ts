import type * as Monaco from "monaco-editor";
import type { IFs } from "wcvm";
import { LANGUAGE_BY_EXTENSION } from "./constants";
import { extensionOf, joinPath, readTextFile } from "./fs.service";

// Monaco's TypeScript service only knows about files that have a model, and a model only exists
// for a file once a tab has been opened. Without this module `import { x } from "./other"` is an
// "unresolved module" error until `other` is opened, and nothing from it is ever suggested. So:
// every project source file gets a background model (kept in sync with disk), and the typings of
// the project's dependencies are registered as extra libs so `import ... from "react"` resolves.

export interface IProjectContext {
  fs: IFs;
  rootPath: string;
}

let context: IProjectContext | null = null;
export const setProjectContext = (next: IProjectContext | null): void => {
  context = next;
};
export const getProjectContext = (): IProjectContext | null => context;

/** Single-file components (not TS-service sources, so they get no background model) - kept as a
 * path list so a template can offer them as auto-importable tags. */
export const COMPONENT_EXTENSIONS = new Set(["vue", "svelte"]);
let componentFiles: string[] = [];
export const getComponentFiles = (): readonly string[] => componentFiles;

const componentListeners = new Set<() => void>();
/** Fires after a project sync changed the set of `.vue` / `.svelte` files. */
export const onComponentFilesChange = (cb: () => void): (() => void) => {
  componentListeners.add(cb);
  return () => componentListeners.delete(cb);
};

export const SOURCE_EXTENSIONS = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"]);
const SKIPPED_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", ".turbo", "coverage"]);
const MAX_SOURCE_FILES = 1500;
const MAX_SOURCE_BYTES = 300_000;

/** A file the language service should know about even when no tab is open on it. */
export const isProjectSource = (path: string): boolean =>
  context != null &&
  path.startsWith(context.rootPath + "/") &&
  !path.includes("/node_modules/") &&
  (SOURCE_EXTENSIONS.has(extensionOf(path)) || COMPONENT_EXTENSIONS.has(extensionOf(path)));

export function configureTypescript(monaco: typeof Monaco): void {
  const ts = monaco.typescript;
  const options: Monaco.typescript.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    jsx: ts.JsxEmit.ReactJSX,
    allowJs: true,
    allowNonTsExtensions: true,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    resolveJsonModule: true,
    skipLibCheck: true,
    // Vite projects import `./App.tsx` with the extension; TS only allows that alongside `noEmit`
    // (the editor never emits).
    allowImportingTsExtensions: true,
    noEmit: true,
    lib: ["esnext", "dom", "dom.iterable"],
  };
  for (const defaults of [ts.typescriptDefaults, ts.javascriptDefaults]) {
    defaults.setCompilerOptions(options);
    // Make every model visible to the worker up front, not only the ones in the active editor.
    defaults.setEagerModelSync(true);
  }
  ts.typescriptDefaults.setDiagnosticsOptions(DIAGNOSTICS_OPTIONS);
}

// 7016: "could not find a declaration file" - noise for untyped packages.
const DIAGNOSTICS_OPTIONS: Monaco.typescript.DiagnosticsOptions = {
  noSemanticValidation: false,
  noSyntaxValidation: false,
  diagnosticCodesToIgnore: [7016],
};

/** Monaco re-validates a model only when that model changes, so an open file whose imports were
 * checked BEFORE a background model / typings for them existed keeps its stale "Cannot find
 * module" error. Re-applying the options fires the defaults' change event, which re-validates
 * every model. */
const refreshDiagnostics = (monaco: typeof Monaco): void => {
  monaco.typescript.typescriptDefaults.setDiagnosticsOptions({ ...DIAGNOSTICS_OPTIONS });
};

// ── project source files ──────────────────────────────────────────────────

interface ISourceFile {
  path: string;
  mtimeMs: number;
}

/** What each background model was last loaded from, so an unchanged file isn't re-read. */
const syncedMtime = new Map<string, number>();
export const invalidateSyncedPath = (path: string): void => {
  syncedMtime.delete(path);
};

async function listSources(fs: IFs, root: string): Promise<{ sources: ISourceFile[]; components: string[] }> {
  const out: ISourceFile[] = [];
  const components: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    if (out.length >= MAX_SOURCE_FILES) return;
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return;
    }
    await Promise.all(
      names.map(async (name) => {
        if (SKIPPED_DIRS.has(name) || out.length >= MAX_SOURCE_FILES) return;
        const path = joinPath(dir, name);
        try {
          const info = await fs.stat(path);
          if (info.kind === "dir") await walk(path);
          else if (
            info.kind === "file" &&
            (SOURCE_EXTENSIONS.has(extensionOf(path)) || COMPONENT_EXTENSIONS.has(extensionOf(path))) &&
            info.size <= MAX_SOURCE_BYTES
          ) {
            out.push({ path, mtimeMs: info.mtimeMs });
            // `.vue` / `.svelte` also get a (background) model - go-to-definition needs a model to land in.
            if (COMPONENT_EXTENSIONS.has(extensionOf(path))) components.push(path);
          }
        } catch {
          /* removed mid-listing */
        }
      }),
    );
  };
  await walk(root);
  return { sources: out, components };
}

let sourceSync: Promise<void> | null = null;

/** Creates / refreshes a background model for every project source file and drops the models of
 * files that no longer exist. `openPaths` (tabs the editor owns) are never touched here. */
export function syncProjectModels(monaco: typeof Monaco, openPaths: ReadonlySet<string>): Promise<void> {
  // One pass at a time; a request that arrives mid-pass queues exactly one more.
  const run = async (): Promise<void> => {
    if (!context) return;
    const { fs, rootPath } = context;
    const { sources: files, components } = await listSources(fs, rootPath);
    const sorted = components.sort();
    const componentsChanged = sorted.join("\n") !== componentFiles.join("\n");
    componentFiles = sorted;
    if (componentsChanged) for (const cb of componentListeners) cb();
    const wanted = new Set(files.map((f) => f.path));
    let changed = false;

    for (const model of monaco.editor.getModels()) {
      const path = model.uri.path;
      if (model.uri.scheme !== "file" || openPaths.has(path) || !isProjectSource(path)) continue;
      if (!wanted.has(path)) {
        model.dispose();
        syncedMtime.delete(path);
        changed = true;
      }
    }

    const BATCH = 24;
    for (let i = 0; i < files.length; i += BATCH) {
      await Promise.all(
        files.slice(i, i + BATCH).map(async ({ path, mtimeMs }) => {
          if (openPaths.has(path)) return;
          const uri = monaco.Uri.file(path);
          const existing = monaco.editor.getModel(uri);
          if (existing && syncedMtime.get(path) === mtimeMs) return;
          let text: string;
          try {
            text = await readTextFile(fs, path);
          } catch {
            return;
          }
          // Re-check after the await: a tab may have opened (and so owns) this path meanwhile.
          const model = monaco.editor.getModel(uri);
          if (model) {
            if (!openPaths.has(path) && model.getValue() !== text) {
              model.setValue(text);
              changed = true;
            }
          } else {
            monaco.editor.createModel(text, LANGUAGE_BY_EXTENSION[extensionOf(path)] ?? "plaintext", uri);
            changed = true;
          }
          syncedMtime.set(path, mtimeMs);
        }),
      );
    }
    if (changed) refreshDiagnostics(monaco);
  };
  const next = (sourceSync ?? Promise.resolve()).then(run, run);
  sourceSync = next.finally(() => {
    if (sourceSync === next) sourceSync = null;
  });
  return next;
}

// ── dependency typings ────────────────────────────────────────────────────

const MAX_PACKAGES = 150;
const MAX_FILES_PER_PACKAGE = 400;
const MAX_TOTAL_BYTES = 8_000_000;
const NEVER_LOAD = new Set(["typescript"]);

interface IPackageJson {
  types?: string;
  typings?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** Direct dependencies that ship (or have @types for) typings - the packages whose exports can be
 * auto-imported. `typingsVersion` bumps whenever that set (or their typings) was reloaded. */
let typedPackages: string[] = [];
let typingsVersion = 0;
export const getTypedPackages = (): readonly string[] => typedPackages;
export const getTypingsVersion = (): number => typingsVersion;
const typingsListeners = new Set<() => void>();
export const onTypingsChange = (cb: () => void): (() => void) => {
  typingsListeners.add(cb);
  return () => typingsListeners.delete(cb);
};

let typingsSignature = "";
let typingLibs: Monaco.IDisposable[] = [];

const isDeclarationFile = (name: string): boolean => /\.d\.[cm]?ts$/.test(name);

/** Registers `.d.ts` files (and package.json, which module resolution reads for `types`) of the
 * project's dependencies - and of the packages those typings pull in - as extra libs at their real
 * `node_modules` paths. Re-runs only when package.json or node_modules changed. */
export async function syncDependencyTypings(monaco: typeof Monaco): Promise<void> {
  if (!context) return;
  const { fs, rootPath } = context;
  let rootPkgText: string;
  try {
    rootPkgText = await readTextFile(fs, joinPath(rootPath, "package.json"));
  } catch {
    return;
  }
  let modulesMtime = 0;
  try {
    modulesMtime = (await fs.stat(joinPath(rootPath, "node_modules"))).mtimeMs;
  } catch {
    /* not installed yet */
  }
  const signature = `${modulesMtime}\n${rootPkgText}`;
  if (signature === typingsSignature) return;
  typingsSignature = signature;

  let rootPkg: IPackageJson;
  try {
    rootPkg = JSON.parse(rootPkgText) as IPackageJson;
  } catch {
    return;
  }

  const libs: Monaco.IDisposable[] = [];
  const visited = new Set<string>();
  let bytes = 0;
  const modules = joinPath(rootPath, "node_modules");
  const addLib = (content: string, path: string): void => {
    bytes += content.length;
    libs.push(monaco.typescript.typescriptDefaults.addExtraLib(content, `file://${path}`));
    libs.push(monaco.typescript.javascriptDefaults.addExtraLib(content, `file://${path}`));
  };

  const collectDeclarations = async (dir: string, found: string[]): Promise<void> => {
    if (found.length >= MAX_FILES_PER_PACKAGE) return;
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === "node_modules" || found.length >= MAX_FILES_PER_PACKAGE) continue;
      const path = joinPath(dir, name);
      if (isDeclarationFile(name)) found.push(path);
      else if (!name.includes(".")) {
        try {
          if ((await fs.stat(path)).kind === "dir") await collectDeclarations(path, found);
        } catch {
          /* ignore */
        }
      }
    }
  };

  /** Returns true if the package has typings of its own. */
  const loadPackage = async (name: string): Promise<boolean> => {
    if (visited.has(name) || NEVER_LOAD.has(name) || visited.size >= MAX_PACKAGES || bytes > MAX_TOTAL_BYTES) {
      return visited.has(name);
    }
    visited.add(name);
    const dir = joinPath(modules, name);
    let pkgText: string;
    try {
      pkgText = await readTextFile(fs, joinPath(dir, "package.json"));
    } catch {
      return false;
    }
    let pkg: IPackageJson = {};
    try {
      pkg = JSON.parse(pkgText) as IPackageJson;
    } catch {
      /* keep going with defaults */
    }
    const files: string[] = [];
    await collectDeclarations(dir, files);
    if (files.length === 0 && !pkg.types && !pkg.typings) return false;
    addLib(pkgText, joinPath(dir, "package.json"));
    for (const file of files) {
      try {
        addLib(await readTextFile(fs, file), file);
      } catch {
        /* unreadable - skip */
      }
    }
    // A typings package imports its own helpers (@types/react -> csstype).
    for (const dep of Object.keys(pkg.dependencies ?? {})) await loadPackage(dep);
    return true;
  };

  const direct = Object.keys({ ...rootPkg.dependencies, ...rootPkg.devDependencies });
  const typed: string[] = [];
  for (const name of direct) {
    if (name.startsWith("@types/")) {
      await loadPackage(name);
      continue;
    }
    const hasOwn = await loadPackage(name);
    if (hasOwn || (await loadPackage(`@types/${name.startsWith("@") ? name.slice(1).replace("/", "__") : name}`))) {
      typed.push(name);
    }
  }

  for (const old of typingLibs) old.dispose();
  typingLibs = libs;
  typedPackages = typed;
  typingsVersion++;
  for (const cb of typingsListeners) cb();
  if (libs.length > 0) refreshDiagnostics(monaco);
}
