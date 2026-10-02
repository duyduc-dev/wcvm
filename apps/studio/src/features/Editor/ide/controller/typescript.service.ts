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
  appliedProjectOptions = "";
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
const GENERATED_TYPE_DIRS = [".next/types", ".next/dev/types"];
const MAX_SOURCE_FILES = 1500;
const MAX_SOURCE_BYTES = 300_000;

/** A file the language service should know about even when no tab is open on it. */
export const isProjectSource = (path: string): boolean =>
  context != null &&
  path.startsWith(context.rootPath + "/") &&
  !path.includes("/node_modules/") &&
  (SOURCE_EXTENSIONS.has(extensionOf(path)) || COMPONENT_EXTENSIONS.has(extensionOf(path)));

let baseCompilerOptions: Monaco.typescript.CompilerOptions = {};

export function configureTypescript(monaco: typeof Monaco): void {
  const ts = monaco.typescript;
  const options: Monaco.typescript.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    // "bundler" (100): resolves a package's `exports` map the way Vite, Next.js, Astro, React Router and
    // SvelteKit do (`react-router/dom`, `@sveltejs/kit/vite`). The old Node-10 setting could not, and
    // TypeScript then builds a diagnostic holding a lazy function - which cannot cross the worker
    // boundary ("... could not be cloned") and was thrown as an uncaught error in Monaco's TS worker.
    // Monaco's own enum predates the value, hence the cast.
    moduleResolution: 100 as unknown as Monaco.typescript.ModuleResolutionKind,
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
  baseCompilerOptions = options;
  for (const defaults of [ts.typescriptDefaults, ts.javascriptDefaults]) {
    defaults.setCompilerOptions(options);
    // Make every model visible to the worker up front, not only the ones in the active editor.
    defaults.setEagerModelSync(true);
  }
  ts.typescriptDefaults.setDiagnosticsOptions(DIAGNOSTICS_OPTIONS);
}

/** `tsconfig.json` is JSONC: comments and trailing commas are legal. */
const parseJsonc = (text: string): unknown => {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 1;
    } else out += ch;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
};

/** `dir` resolved against `base` ("." and ".." collapsed), as an absolute path. */
const resolveAgainst = (base: string, dir: string): string => {
  const out: string[] = [];
  for (const part of (dir.startsWith("/") ? dir : `${base}/${dir}`).split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return "/" + out.join("/");
};

let appliedProjectOptions = "";

/** Boolean `compilerOptions` copied from the project's `tsconfig.json`. Monaco's own options are
 * fixed, and these change what the editor reports: without `experimentalDecorators` NestJS's
 * `@Get()` is checked as a standard (TC39) decorator - "Unable to resolve signature of method
 * decorator when called as an expression" - because that is TypeScript's default. */
const TSCONFIG_FLAGS = [
  "experimentalDecorators",
  "emitDecoratorMetadata",
  "strict",
  "noImplicitAny",
  "strictNullChecks",
  "noUnusedLocals",
  "noUnusedParameters",
  "useDefineForClassFields",
  "noImplicitReturns",
  "noFallthroughCasesInSwitch",
  "noUncheckedIndexedAccess",
  "exactOptionalPropertyTypes",
] as const;

/** The project's own `tsconfig.json` options that Monaco's fixed ones knew nothing about: `rootDirs`
 * and the flags in TSCONFIG_FLAGS.
 * Frameworks that generate types into a parallel tree depend on `rootDirs`: React Router 7 imports
 * `./+types/root` from `app/root.tsx`, and `rootDirs: [".", "./.react-router/types"]` is what makes
 * that resolve to `.react-router/types/app/+types/root.ts`. Without it the editor reports
 * "Cannot find module './+types/root'" even though `react-router dev` generated the file. */
export async function syncTsconfigOptions(monaco: typeof Monaco): Promise<void> {
  if (!context) return;
  const { fs, rootPath } = context;
  const fromProject: Record<string, unknown> = {};
  try {
    const config = parseJsonc(await readTextFile(fs, joinPath(rootPath, "tsconfig.json"))) as {
      compilerOptions?: Record<string, unknown>;
    };
    const compilerOptions = config.compilerOptions ?? {};
    const dirs = compilerOptions.rootDirs;
    if (Array.isArray(dirs)) {
      // The worker names files by their URI, so rootDirs have to be URIs too.
      fromProject.rootDirs = dirs.filter((d): d is string => typeof d === "string").map((d) => `file://${resolveAgainst(rootPath, d)}`);
    }
    for (const flag of TSCONFIG_FLAGS) {
      if (typeof compilerOptions[flag] === "boolean") fromProject[flag] = compilerOptions[flag];
    }
  } catch {
    /* no tsconfig, or one this can't parse: keep the defaults */
  }
  const signature = JSON.stringify(fromProject);
  if (signature === appliedProjectOptions) return;
  appliedProjectOptions = signature;
  const options = { ...baseCompilerOptions, ...fromProject } as Monaco.typescript.CompilerOptions;
  for (const defaults of [monaco.typescript.typescriptDefaults, monaco.typescript.javascriptDefaults]) {
    defaults.setCompilerOptions(options);
  }
  refreshDiagnostics(monaco);
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
  // Type declarations a framework generates into an otherwise skipped folder, which its tsconfig
  // `include`s: Next's `LayoutProps` / `PageProps` / `RouteContext` globals live in
  // `.next/types` (`next typegen`) and `.next/dev/types` (`next dev`).
  for (const dir of GENERATED_TYPE_DIRS) await walk(joinPath(root, dir));
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
// next ships ~1600 declaration files (dist/ alone is ~1500); the byte cap below is what really bounds a load.
const MAX_FILES_PER_PACKAGE = 3000;
const READ_CONCURRENCY = 32;
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
let typingsRun = 0;

/** Brings the language service up to date after `npm install` (or anything else that rewrote
 * `node_modules`): forgets the typings signature - a sync that ran MID-install recorded it against
 * a half-installed tree, and node_modules' mtime alone can't be trusted to differ afterwards - then
 * reloads the dependency typings and re-validates every open model (type errors and lint). */
export async function syncAfterInstall(monaco: typeof Monaco): Promise<void> {
  typingsSignature = "";
  await syncDependencyTypings(monaco);
  // syncDependencyTypings only re-validates when it found typings; an untyped (JS) project still
  // has "Cannot find module" markers from before the install.
  refreshDiagnostics(monaco);
  monaco.typescript.javascriptDefaults.setDiagnosticsOptions({ ...DIAGNOSTICS_OPTIONS });
}
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
  const run = ++typingsRun;

  let rootPkg: IPackageJson;
  try {
    rootPkg = JSON.parse(rootPkgText) as IPackageJson;
  } catch {
    return;
  }

  // Read everything first, register at the very end (see the commit below): Monaco's addExtraLib
  // hands back a NO-OP disposable when a lib with the same path AND content already exists, so
  // adding the new libs before disposing the old ones lets the old disposables delete the
  // identical new ones - every typing that didn't change vanished on a reload of the typings.
  const pending: { content: string; path: string }[] = [];
  const visited = new Set<string>();
  let bytes = 0;
  const modules = joinPath(rootPath, "node_modules");
  const addLib = (content: string, path: string): void => {
    bytes += content.length;
    pending.push({ content, path });
  };

  /** Breadth-first, so the shallow files - a package's own entry points (`next/image.d.ts`,
   * `index.d.ts`) - are always collected before the file cap can cut a deep folder like `dist/`
   * short. (Depth-first in alphabetical order filled the cap inside `dist/` and never got to them.) */
  const collectDeclarations = async (root: string, found: string[]): Promise<void> => {
    const queue = [root];
    for (let next = 0; next < queue.length && found.length < MAX_FILES_PER_PACKAGE; next++) {
      const dir = queue[next];
      let names: string[];
      try {
        names = await fs.readdir(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (name === "node_modules") continue;
        const path = joinPath(dir, name);
        if (isDeclarationFile(name)) {
          if (found.length < MAX_FILES_PER_PACKAGE) found.push(path);
        } else if (!name.includes(".")) {
          try {
            if ((await fs.stat(path)).kind === "dir") queue.push(path);
          } catch {
            /* ignore */
          }
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
    for (let i = 0; i < files.length && bytes <= MAX_TOTAL_BYTES; i += READ_CONCURRENCY) {
      await Promise.all(
        files.slice(i, i + READ_CONCURRENCY).map(async (file) => {
          try {
            addLib(await readTextFile(fs, file), file);
          } catch {
            /* unreadable - skip */
          }
        }),
      );
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

  // A newer sync started while this one was reading (an install was still writing): it has the
  // fresher tree and will commit - committing this one's would overwrite it with a stale view.
  if (run !== typingsRun) return;
  // Dispose, then add, with no await between: the language service never sees a half state.
  for (const old of typingLibs) old.dispose();
  const libs: Monaco.IDisposable[] = [];
  for (const { content, path } of pending) {
    libs.push(monaco.typescript.typescriptDefaults.addExtraLib(content, `file://${path}`));
    libs.push(monaco.typescript.javascriptDefaults.addExtraLib(content, `file://${path}`));
  }
  typingLibs = libs;
  typedPackages = typed;
  typingsVersion++;
  for (const cb of typingsListeners) cb();
  if (libs.length > 0) refreshDiagnostics(monaco);
}
