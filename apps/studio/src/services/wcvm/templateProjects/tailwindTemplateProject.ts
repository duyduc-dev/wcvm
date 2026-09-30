import { getWcvmInstance } from "@/lib/wcvm";
import { collectText } from "./processUtils";
import { populateCache, tryCloneFromCache } from "./templateCache";
import { pinVitePackage } from "./vitePins";

export interface TailwindTemplateCreationResult {
  isFailure: boolean;
  message: string;
  type?: string;
}

// Tailwind CSS v4's own official Vite integration (@tailwindcss/vite) has no create-vite template
// of its own, so - same approach as bootstrapTemplateProject.ts - this starts from Vite's own
// "vanilla-ts" scaffold and wires Tailwind in directly.
//
// Unlike Bootstrap (plain CSS/JS, no native dependency), @tailwindcss/vite statically imports
// @tailwindcss/oxide (a Scanner, native Rust via napi-rs) and, transitively through
// @tailwindcss/node, lightningcss (also native Rust) - both normally need a real platform binary,
// which nothing in this sandbox can run. Root-caused by reading each package's own published
// source directly (not assumed), and PROVEN standalone first (see the "Tailwind v4 native deps"
// Playwright describe block in examples/playground/e2e/boot.spec.ts) before this template was
// built on top of it:
// - lightningcss: swapped for lightningcss-wasm via `overrides` (vitePins.ts's WASM_OVERRIDES),
//   the exact same trick esbuild/rollup already use. Its own "node" condition target
//   (wcvm's ESM resolver already recognizes "node") is coincidentally sandbox-friendly as-is: real
//   fs.readFileSync(new URL(...)) + SYNCHRONOUS WebAssembly.Module/Instance - no ESM-condition
//   change needed at all.
// - @tailwindcss/oxide: its own index.js is a native-binary-first napi-rs loader that (in wcvm)
//   exhausts every real platform binary and finally tries @tailwindcss/oxide-wasm32-wasi's main
//   entry, which requires "node:wasi" - unimplemented here - so it throws. BUT that package
//   declares cpu:["wasm32"] - exactly what installer's own PLATFORM.cpu fakes for esbuild/rollup's
//   wasm32 variants too - so wcvm's npm already installs it, AND it ships its own
//   tailwindcss-oxide.wasi-browser.js: the same @napi-rs/wasm-runtime shape (memfs(),
//   instantiateNapiModuleSync, onCreateWorker spawning a real `new Worker(...)`) already proven to
//   run inside wcvm for @rolldown/browser's own WASI build (see PLAN.md's Rolldown-WASM research) -
//   the already-committed rawWorker.ts ThreadManager fix and rawFetch.ts file: fix carry over
//   directly. The remaining wrinkle: that file is real ESM (top-level import/await) sitting in a
//   package with no "type":"module" (only ever reached, in real usage, via a bundler honoring the
//   legacy string "browser" package.json field - never plain Node resolution, which is all wcvm
//   has) - fixed below with a POST-INSTALL PATCH: rename it to .mjs (unambiguously ESM regardless
//   of package.json "type") and replace @tailwindcss/oxide's own index.js + package.json with a
//   small ESM re-export shim pointing at it via a RELATIVE specifier (a bare
//   "@tailwindcss/oxide-wasm32-wasi/..." subpath hits wcvm's ESM resolver's own simplification -
//   no "exports" map there means subpaths are rejected outright, unlike real Node's legacy
//   any-subpath-resolves fallback - but both packages are npm-hoisted siblings under the same
//   @tailwindcss/ scope directory, so a relative specifier sidesteps package resolution entirely).
//
// A SEPARATE, deeper problem surfaced integrating this into a real dev server: @tailwindcss/vite's
// own stock plugin calls `Scanner.scan()` (native FS globbing/reading), which spawns a WASI
// worker thread whose own file reads relay back to the CREATOR thread's in-memory filesystem via
// postMessage + Atomics.wait - but the creator thread is ITSELF already frozen in its own separate
// Atomics.wait, waiting for that same worker to finish. A genuine, structural deadlock (confirmed
// directly: a heartbeat timer stops dead the instant scan() is called), not something
// asyncWorkPoolSize/RAYON_NUM_THREADS can avoid (a worker is unconditionally created regardless of
// either). `Scanner.scanFiles()` (content-based, no native FS access) avoids THAT specific case,
// but deadlocks too the moment it's given more than one line's worth of input in a single call -
// whether that's one multi-line string OR multiple single-line entries together (confirmed in
// complete isolation both ways). The actual, viable fix: @tailwindcss/vite's own plugin bundle
// (dist/index.mjs, patched below) reads real files itself (via wcvm's own fs.globSync - Node's
// real built-in glob, needing internal/deps/minimatch vendored, a genuine new wcvm capability, see
// CLAUDE.md's Status) and calls scanFiles() ONCE PER NON-BLANK LINE, accumulating candidates -
// proven fast (native calls, not the deadlocking pool path) and correct against a realistic,
// multi-line file with several real Tailwind classes scattered across it.
const VITE_CONFIG_TS = `import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [tailwindcss()],
});
`;

const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Vite + Tailwind CSS</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
`;

const INDEX_CSS = `@import "tailwindcss";
`;

// Tailwind's own real brand mark (the two interlocking wave shapes, sky-blue #38bdf8) - the exact
// same path/viewBox already verified in CreateTemplateDialog/templateIcons.tsx's TailwindLogoIcon
// (used for this template's OWN picker entry), just as a standalone .svg file instead of a React
// component, so MAIN_TS can import it as an asset exactly like vite.svg/typescript.svg already are.
const TAILWIND_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 154" aria-hidden="true">
  <path fill="#38bdf8" d="M128 0C93.867 0 72.533 17.067 64 51.2C76.8 34.133 91.733 27.733 108.8 32c9.737 2.434 16.697 9.499 24.401 17.318C145.751 62.057 160.275 76.8 192 76.8c34.133 0 55.467-17.067 64-51.2c-12.8 17.067-27.733 23.467-44.8 19.2c-9.737-2.434-16.697-9.499-24.401-17.318C173.999 14.743 159.475 0 128 0M64 76.8C29.867 76.8 8.533 93.867 0 128c12.8-17.067 27.733-23.467 44.8-19.2c9.737 2.434 16.697 9.499 24.401 17.318C81.751 138.857 96.275 153.6 128 153.6c34.133 0 55.467-17.067 64-51.2c-12.8 17.067-27.733 23.467-44.8 19.2c-9.737-2.434-16.697-9.499-24.401-17.318C109.999 91.543 95.475 76.8 64 76.8"/>
</svg>
`;

// Same "Get started" hero/docs/social layout create-vite's own vanilla-ts scaffold ships (also
// shared by the Preact/Lit/Solid/Qwik templates - see this file's own top comment on why that
// scaffold's real assets are kept, not reinvented), restyled with Tailwind utility classes instead
// of vanilla-ts's own hand-written style.css. counter.ts is untouched (it only ever sets
// textContent, no styling of its own) and kept as-is; only style.css is replaced. The "framework"
// logo slot (TypeScript, in the stock vanilla-ts scaffold) is swapped for Tailwind's own mark -
// the same convention every other framework template here already follows (e.g. preact-ts swaps
// it for the Preact logo, keeping Vite's own logo as the second overlay) - this template's whole
// point is Tailwind, not TypeScript.
const MAIN_TS = `import "./index.css";
import heroImg from "./assets/hero.png";
import tailwindLogo from "./assets/tailwind.svg";
import viteLogo from "./assets/vite.svg";
import { setupCounter } from "./counter.ts";

document.querySelector<HTMLDivElement>("#app")!.innerHTML = \`
  <div class="mx-auto flex min-h-svh max-w-[1126px] flex-col border-x border-slate-200 dark:border-slate-800">
    <section class="flex flex-grow flex-col items-center justify-center gap-5 px-5 py-8 text-center">
      <div class="relative w-[170px]">
        <img src="\${heroImg}" width="170" height="179" class="relative z-0 mx-auto w-[170px]" />
        <img
          src="\${tailwindLogo}"
          alt="Tailwind CSS logo"
          class="absolute inset-x-0 top-[38px] z-10 mx-auto h-6 w-auto [transform:perspective(2000px)_rotateZ(300deg)_rotateX(44deg)_rotateY(39deg)_scale(1.4)]"
        />
        <img
          src="\${viteLogo}"
          alt="Vite logo"
          class="absolute inset-x-0 top-[107px] z-0 mx-auto h-[26px] w-auto [transform:perspective(2000px)_rotateZ(300deg)_rotateX(40deg)_rotateY(39deg)_scale(0.8)]"
        />
      </div>
      <div>
        <h1 class="my-6 text-4xl font-medium tracking-tight text-slate-900 sm:text-5xl dark:text-slate-100">Get started</h1>
        <p class="text-slate-500 dark:text-slate-400">
          Edit <code class="rounded bg-slate-100 px-2 py-1 font-mono text-sm text-slate-900 dark:bg-slate-800 dark:text-slate-100">src/main.ts</code>
          and save to test <code class="rounded bg-slate-100 px-2 py-1 font-mono text-sm text-slate-900 dark:bg-slate-800 dark:text-slate-100">HMR</code>
        </p>
      </div>
      <button
        id="counter"
        type="button"
        class="mb-2 inline-flex rounded-md border-2 border-transparent bg-violet-500/10 px-3 py-1.5 font-mono text-base text-violet-600 transition-colors hover:border-violet-500/50 focus-visible:outline-2 focus-visible:outline-violet-600 dark:text-violet-400"
      ></button>
    </section>

    <section class="flex flex-col border-t border-slate-200 text-left sm:flex-row dark:border-slate-800">
      <div class="flex-1 border-b border-slate-200 p-6 sm:border-r sm:border-b-0 sm:p-8 dark:border-slate-800">
        <svg class="mb-4 h-[22px] w-[22px] text-slate-900 dark:text-slate-100" role="presentation" aria-hidden="true"><use href="/icons.svg#documentation-icon"></use></svg>
        <h2 class="mb-2 text-xl font-medium text-slate-900 sm:text-2xl dark:text-slate-100">Documentation</h2>
        <p class="text-slate-500 dark:text-slate-400">Your questions, answered</p>
        <ul class="mt-8 flex flex-wrap justify-center gap-2 sm:justify-start">
          <li class="basis-[calc(50%_-_4px)] sm:basis-auto">
            <a href="https://vite.dev/" target="_blank" class="flex items-center justify-center gap-2 rounded-md bg-slate-100/50 px-3 py-1.5 text-slate-900 no-underline transition-shadow hover:shadow-lg sm:justify-start dark:bg-slate-800/50 dark:text-slate-100">
              <img class="h-[18px]" src="\${viteLogo}" alt="" />
              Explore Vite
            </a>
          </li>
          <li class="basis-[calc(50%_-_4px)] sm:basis-auto">
            <a href="https://tailwindcss.com/docs" target="_blank" class="flex items-center justify-center gap-2 rounded-md bg-slate-100/50 px-3 py-1.5 text-slate-900 no-underline transition-shadow hover:shadow-lg sm:justify-start dark:bg-slate-800/50 dark:text-slate-100">
              <img class="h-[18px] w-[18px]" src="\${tailwindLogo}" alt="" />
              Tailwind docs
            </a>
          </li>
        </ul>
      </div>
      <div class="flex-1 p-6 sm:p-8">
        <svg class="mb-4 h-[22px] w-[22px] text-slate-900 dark:text-slate-100" role="presentation" aria-hidden="true"><use href="/icons.svg#social-icon"></use></svg>
        <h2 class="mb-2 text-xl font-medium text-slate-900 sm:text-2xl dark:text-slate-100">Connect with us</h2>
        <p class="text-slate-500 dark:text-slate-400">Join the Vite community</p>
        <ul class="mt-8 flex flex-wrap justify-center gap-2 sm:justify-start">
          <li class="basis-[calc(50%_-_4px)] sm:basis-auto">
            <a href="https://github.com/vitejs/vite" target="_blank" class="flex items-center justify-center gap-2 rounded-md bg-slate-100/50 px-3 py-1.5 text-slate-900 no-underline transition-shadow hover:shadow-lg sm:justify-start dark:bg-slate-800/50 dark:text-slate-100">
              <svg class="h-[18px] w-[18px]" role="presentation" aria-hidden="true"><use href="/icons.svg#github-icon"></use></svg>
              GitHub
            </a>
          </li>
          <li class="basis-[calc(50%_-_4px)] sm:basis-auto">
            <a href="https://chat.vite.dev/" target="_blank" class="flex items-center justify-center gap-2 rounded-md bg-slate-100/50 px-3 py-1.5 text-slate-900 no-underline transition-shadow hover:shadow-lg sm:justify-start dark:bg-slate-800/50 dark:text-slate-100">
              <svg class="h-[18px] w-[18px]" role="presentation" aria-hidden="true"><use href="/icons.svg#discord-icon"></use></svg>
              Discord
            </a>
          </li>
          <li class="basis-[calc(50%_-_4px)] sm:basis-auto">
            <a href="https://x.com/vite_js" target="_blank" class="flex items-center justify-center gap-2 rounded-md bg-slate-100/50 px-3 py-1.5 text-slate-900 no-underline transition-shadow hover:shadow-lg sm:justify-start dark:bg-slate-800/50 dark:text-slate-100">
              <svg class="h-[18px] w-[18px]" role="presentation" aria-hidden="true"><use href="/icons.svg#x-icon"></use></svg>
              X.com
            </a>
          </li>
          <li class="basis-[calc(50%_-_4px)] sm:basis-auto">
            <a href="https://bsky.app/profile/vite.dev" target="_blank" class="flex items-center justify-center gap-2 rounded-md bg-slate-100/50 px-3 py-1.5 text-slate-900 no-underline transition-shadow hover:shadow-lg sm:justify-start dark:bg-slate-800/50 dark:text-slate-100">
              <svg class="h-[18px] w-[18px]" role="presentation" aria-hidden="true"><use href="/icons.svg#bluesky-icon"></use></svg>
              Bluesky
            </a>
          </li>
        </ul>
      </div>
    </section>
  </div>
\`;

setupCounter(document.querySelector<HTMLButtonElement>("#counter")!);
`;

/** Reads the real, published @tailwindcss/vite plugin bundle out of node_modules and rewrites its
 *  own `Scanner.scan()` call (deadlocks - see this file's own top comment) into a real-file-
 *  reading, one-scanFiles()-call-per-line equivalent. Pure string transform - no wcvm/browser API
 *  needed, so it's plain, synchronous, easily unit-testable logic (mirrored in boot.spec.ts's own
 *  copy for its standalone Playwright verification). Throws if the plugin's own source doesn't
 *  contain an expected anchor - a version bump changing its shape should fail loudly, not silently
 *  ship a plugin that still calls the real, deadlocking scan(). */
function patchTailwindVitePlugin(source: string): string {
  const replacements: [string, string][] = [
    [
      'import*as M from"vite";',
      'import*as M from"vite";import{readFileSync as __wcvmReadFileSync,globSync as __wcvmGlobSync}from"node:fs";' +
        "function __wcvmScanSources(sources){" +
        "const files=new Set();" +
        "for(const s of sources){" +
        "if(s.negated)continue;" +
        "let matches=[];" +
        'try{matches=__wcvmGlobSync(s.pattern,{cwd:s.base,exclude:p=>p.split("/").some(seg=>seg==="node_modules"||(seg.startsWith(".")&&seg!=="."&&seg!==".."))});}catch{}' +
        'for(const m of matches)files.add(m.startsWith("/")?m:s.base+"/"+m);' +
        "}" +
        "return[...files];" +
        "}" +
        'const __wcvmBinaryExt=new Set(["png","jpg","jpeg","gif","webp","avif","ico","bmp","woff","woff2","ttf","otf","eot","mp4","webm","mp3","wav","ogg","pdf","zip","gz","wasm"]);' +
        "function __wcvmScanFiles(scanner,sources){" +
        "const files=__wcvmScanSources(sources||[]);" +
        "const candidates=new Set();" +
        "for(const file of files){" +
        'const dot=file.lastIndexOf(".");' +
        'const extension=dot===-1?"":file.slice(dot+1).toLowerCase();' +
        "if(__wcvmBinaryExt.has(extension))continue;" +
        "let content;" +
        'try{content=__wcvmReadFileSync(file,"utf8");}catch{continue;}' +
        'for(const line of content.split("\\n")){' +
        "if(!line.trim())continue;" +
        "for(const c of scanner.scanFiles([{content:line,extension}]))candidates.add(c);" +
        "}" +
        "}" +
        "return{candidates:[...candidates],files};" +
        "}",
    ],
    ["this.scanner=new Y({sources:d})", "this.scanner=new Y({sources:d}),this.__wcvmSources=d"],
    [
      "for(let i of this.scanner.scan())this.candidates.add(i);",
      "{let __r=__wcvmScanFiles(this.scanner,this.__wcvmSources);this.__wcvmScannedFiles=__r.files;for(let i of __r.candidates)this.candidates.add(i);}",
    ],
    ["for(let i of this.scanner.files)c(i)", "for(let i of(this.__wcvmScannedFiles||[]))c(i)"],
    [
      'for(let i of this.scanner.globs){if(i.pattern[0]==="!")continue;',
      'for(let i of(this.__wcvmSources||[])){if(i.negated||i.pattern[0]==="!")continue;',
    ],
    ["get scannedFiles(){return this.scanner?.files??[]}", "get scannedFiles(){return this.__wcvmScannedFiles??[]}"],
  ];
  let patched = source;
  for (const [from, to] of replacements) {
    if (!patched.includes(from)) throw new Error(`Tailwind Vite plugin patch anchor not found: ${JSON.stringify(from.slice(0, 60))}`);
    patched = patched.replace(from, to);
  }
  return patched;
}

/** Patches the two already-broken node_modules entries described in this file's own top comment -
 *  proven standalone (boot.spec.ts's "Tailwind v4 native deps" describe block). A no-op (returns
 *  false) if @tailwindcss/oxide-wasm32-wasi didn't end up installed - shouldn't happen given
 *  install.ts's own PLATFORM.cpu="wasm32", but falling through to a clear install failure beats a
 *  cryptic runtime one. */
async function patchOxideForBrowser(projectPath: string): Promise<boolean> {
  const wc = getWcvmInstance();
  const wasiPkgDir = `${projectPath}/node_modules/@tailwindcss/oxide-wasm32-wasi`;
  if (!(await wc.fs.exists(wasiPkgDir))) return false;

  const browserJs = new TextDecoder().decode(await wc.fs.readFile(`${wasiPkgDir}/tailwindcss-oxide.wasi-browser.js`));
  await wc.fs.writeFile(`${wasiPkgDir}/tailwindcss-oxide.wasi-browser.mjs`, browserJs);

  const oxideDir = `${projectPath}/node_modules/@tailwindcss/oxide`;
  await wc.fs.writeFile(`${oxideDir}/package.json`, JSON.stringify({ name: "@tailwindcss/oxide", version: "4.3.3", type: "module", main: "index.js" }));
  await wc.fs.writeFile(
    `${oxideDir}/index.js`,
    [
      'export * from "../oxide-wasm32-wasi/tailwindcss-oxide.wasi-browser.mjs";',
      'export { default } from "../oxide-wasm32-wasi/tailwindcss-oxide.wasi-browser.mjs";',
    ].join("\n"),
  );
  return true;
}

/** Patches @tailwindcss/vite's own plugin bundle (see patchTailwindVitePlugin's own doc comment) -
 *  a no-op returning false if the package isn't where expected (shouldn't happen right after our
 *  own npm install, but falling through to a clear failure beats a cryptic one). */
async function patchTailwindVitePluginOnDisk(projectPath: string): Promise<boolean> {
  const wc = getWcvmInstance();
  const viteDir = `${projectPath}/node_modules/@tailwindcss/vite`;
  const entryPath = `${viteDir}/dist/index.mjs`;
  if (!(await wc.fs.exists(entryPath))) return false;
  const original = new TextDecoder().decode(await wc.fs.readFile(entryPath));
  await wc.fs.writeFile(entryPath, patchTailwindVitePlugin(original));
  return true;
}

const createTailwindTemplateProject = async (
  projectPath: string,
  onProgress?: (message: string) => void,
): Promise<TailwindTemplateCreationResult> => {
  const wc = getWcvmInstance();

  const isExisting = await wc.fs.exists(projectPath);
  if (isExisting) {
    return {
      isFailure: true,
      message: `A project already exists at ${projectPath}`,
      type: "projectName",
    };
  }

  onProgress?.("Checking the local template cache…");
  if (await tryCloneFromCache("tailwind", projectPath)) {
    return { isFailure: false, message: "ok" };
  }

  onProgress?.("Scaffolding a Vite + TypeScript base…");
  const created = await wc.spawn(
    "npm",
    [
      "create",
      "vite@latest",
      projectPath.slice(1),
      "--",
      "--template",
      "vanilla-ts",
      "--no-interactive",
    ],
    { cwd: "/" },
  );
  const createdLog = await collectText(created);
  const createdExit = await created.exit;
  if (createdExit.exitCode !== 0) {
    return { isFailure: true, message: `npm create vite failed:\n${createdLog.trim()}` };
  }

  onProgress?.("Wiring up Tailwind CSS v4…");
  const pkgPath = `${projectPath}/package.json`;
  const pkg = JSON.parse(new TextDecoder().decode(await wc.fs.readFile(pkgPath)));
  // Tailwind's own monorepo locks @tailwindcss/vite, @tailwindcss/node, @tailwindcss/oxide and
  // tailwindcss itself to the SAME exact version - pinning @tailwindcss/vite alone (exact, not
  // caret) keeps every one of those in the version this template's own node_modules patches were
  // verified against (their file names/shapes aren't guaranteed stable across versions).
  pkg.devDependencies = { ...pkg.devDependencies, "@tailwindcss/vite": "4.3.3" };
  pinVitePackage(pkg);
  await wc.fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2));
  await wc.fs.writeFile(`${projectPath}/vite.config.ts`, VITE_CONFIG_TS);
  await wc.fs.writeFile(`${projectPath}/index.html`, INDEX_HTML);
  await wc.fs.writeFile(`${projectPath}/src/main.ts`, MAIN_TS);
  await wc.fs.writeFile(`${projectPath}/src/index.css`, INDEX_CSS);
  await wc.fs.writeFile(`${projectPath}/src/assets/tailwind.svg`, TAILWIND_LOGO_SVG);
  // vanilla-ts's own counter.ts is kept as-is (MAIN_TS still imports and uses it - it only ever
  // sets textContent, no styling of its own to conflict with Tailwind) and its own hero/vite/
  // favicon/icons assets are kept too (MAIN_TS's own hero composition imports them directly - see
  // this file's own top comment). style.css is replaced by Tailwind, and typescript.svg is no
  // longer referenced (the "framework" logo slot is Tailwind's own mark here, not TypeScript's).
  if (await wc.fs.exists(`${projectPath}/src/style.css`)) {
    await wc.fs.rm(`${projectPath}/src/style.css`);
  }
  if (await wc.fs.exists(`${projectPath}/src/assets/typescript.svg`)) {
    await wc.fs.rm(`${projectPath}/src/assets/typescript.svg`);
  }

  onProgress?.("Installing dependencies from the npm registry (about 10s)…");
  const install = await wc.spawn("npm", ["install"], { cwd: projectPath });
  const installLog = await collectText(install);
  const installExit = await install.exit;
  if (installExit.exitCode !== 0) {
    return { isFailure: true, message: `npm install failed:\n${installLog.trim()}` };
  }

  onProgress?.("Patching @tailwindcss/oxide and @tailwindcss/vite for this sandbox…");
  if (!(await patchOxideForBrowser(projectPath))) {
    return { isFailure: true, message: "npm install succeeded, but @tailwindcss/oxide-wasm32-wasi wasn't installed - cannot patch it for this sandbox." };
  }
  if (!(await patchTailwindVitePluginOnDisk(projectPath))) {
    return { isFailure: true, message: "npm install succeeded, but @tailwindcss/vite wasn't installed where expected - cannot patch it for this sandbox." };
  }

  // OPFS persistence (boot({persist})) is write-behind - without this, a reload right after
  // "created" reports success could still lose files npm install (or the patches above) just
  // wrote but hadn't finished mirroring yet (see wc.fs.sync()'s own doc comment). A no-op when
  // persistence isn't enabled.
  await wc.fs.sync();

  // Fire-and-forget, AFTER the real project is already synced and reported - see
  // populateCache's own comment for why folding this into the sync() above would be wrong. The
  // cached copy includes both patches above (populateCache clones the whole project directory),
  // so a future clone never needs to re-patch.
  void populateCache("tailwind", projectPath);

  return { isFailure: false, message: "ok" };
};

export { createTailwindTemplateProject };
