import { getWcvmInstance } from "@/lib/wcvm";
import { collectText } from "./processUtils";
import { populateCache, tryCloneFromCache } from "./templateCache";
import { pinVitePackage } from "./vitePins";

export interface RectifyTemplateCreationResult {
  isFailure: boolean;
  message: string;
  type?: string;
}

// The real Rectify logo (https://rectify-teams.github.io/rectify/img/logo.svg) - a hexagon
// outline with an "R" mark, fetched directly from the docs site rather than fabricated. Written
// to its own asset file (src/assets/rectify.svg) so it can be imported through Vite's normal
// asset pipeline exactly like the scaffold's own vite.svg, replacing react-ts's react.svg in the
// same two spots (the hero's "framework" logo layer, and the docs section's second link icon).
const RECTIFY_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="none">
  <polygon points="50,5 93,27.5 93,72.5 50,95 7,72.5 7,27.5" stroke="#7c6af7" stroke-width="6" fill="none"/>
  <text x="50" y="62" text-anchor="middle" font-size="42" font-weight="bold" font-family="system-ui" fill="#a78bfa">R</text>
</svg>
`;

// Mirrors create-vite's own react-ts landing page verbatim (same hero/counter/docs sections, same
// App.css/index.css this project scaffolds from react-ts to get for free - see below) so a fresh
// Rectify project looks and feels the same as a fresh React one, including the hero's
// framework-logo layer and the docs section's second link - both now using Rectify's own real
// logo (RECTIFY_LOGO_SVG above) instead of react.svg, since Rectify isn't React. Everything else
// (hero.png, vite.svg, the counter, the social section, all the CSS) is the scaffold's own real
// file, untouched.
const APP_TSX = `import { useState } from "@rectify-dev/core";
import heroImg from "./assets/hero.png";
import rectifyLogo from "./assets/rectify.svg";
import viteLogo from "./assets/vite.svg";
import "./App.css";

function App() {
  const [count, setCount] = useState(0);

  return (
    <>
      <section id="center">
        <div className="hero">
          <img src={heroImg} className="base" width="170" height="179" alt="" />
          <img src={rectifyLogo} className="framework" alt="Rectify logo" />
          <img src={viteLogo} className="vite" alt="Vite logo" />
        </div>
        <div>
          <h1>Get started</h1>
          <p>
            Edit <code>src/App.tsx</code> and save to test <code>HMR</code>
          </p>
        </div>
        <button type="button" className="counter" onClick={() => setCount((c) => c + 1)}>
          Count is {count}
        </button>
      </section>

      <div className="ticks"></div>

      <section id="next-steps">
        <div id="docs">
          <svg className="icon" role="presentation" aria-hidden="true">
            <use href="/icons.svg#documentation-icon"></use>
          </svg>
          <h2>Documentation</h2>
          <p>Your questions, answered</p>
          <ul>
            <li>
              <a href="https://vite.dev/" target="_blank">
                <img className="logo" src={viteLogo} alt="" />
                Explore Vite
              </a>
            </li>
            <li>
              <a href="https://rectify-teams.github.io/rectify" target="_blank">
                <img className="button-icon" src={rectifyLogo} alt="" />
                Learn Rectify
              </a>
            </li>
          </ul>
        </div>
        <div id="social">
          <svg className="icon" role="presentation" aria-hidden="true">
            <use href="/icons.svg#social-icon"></use>
          </svg>
          <h2>Connect with us</h2>
          <p>Join the Vite community</p>
          <ul>
            <li>
              <a href="https://github.com/vitejs/vite" target="_blank">
                <svg className="button-icon" role="presentation" aria-hidden="true">
                  <use href="/icons.svg#github-icon"></use>
                </svg>
                GitHub
              </a>
            </li>
            <li>
              <a href="https://chat.vite.dev/" target="_blank">
                <svg className="button-icon" role="presentation" aria-hidden="true">
                  <use href="/icons.svg#discord-icon"></use>
                </svg>
                Discord
              </a>
            </li>
            <li>
              <a href="https://x.com/vite_js" target="_blank">
                <svg className="button-icon" role="presentation" aria-hidden="true">
                  <use href="/icons.svg#x-icon"></use>
                </svg>
                X.com
              </a>
            </li>
            <li>
              <a href="https://bsky.app/profile/vite.dev" target="_blank">
                <svg className="button-icon" role="presentation" aria-hidden="true">
                  <use href="/icons.svg#bluesky-icon"></use>
                </svg>
                Bluesky
              </a>
            </li>
          </ul>
        </div>
      </section>

      <div className="ticks"></div>
      <section id="spacer"></section>
    </>
  );
}

export default App;
`;

// react-ts's own index.html has <div id="root"> (unlike vanilla-ts's "app") - this project now
// scaffolds from react-ts (see below), so this targets the real container it actually has. No `!`
// non-null assertion here on purpose: `rectifyBabelPlugin` (inside @rectify-dev/vite-plugin) only
// transforms JSX nodes, it doesn't strip TypeScript syntax at all - fine for the file's NORMAL
// per-request transform (Vite's own esbuild step runs afterward and strips whatever Babel left
// behind), but Vite's separate, eager dependency-SCAN step also runs this same Babel plugin
// (vite-plugin-babel's own `optimizeDeps.esbuildOptions.plugins` contribution) and does NOT tell
// esbuild which loader to use for its already-Babel'd output - esbuild then guesses "js" and
// chokes on any leftover TS-only syntax with a raw "Unexpected "!"" parse error, confirmed
// directly. Vite recovers on its own (skips eager pre-bundling, falls back to lazy per-request
// optimization - the app still renders either way), but avoiding the assertion here keeps the dev
// server's startup log clean.
const MAIN_TSX = `import { createRoot } from "@rectify-dev/core";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")).render(<App />);
`;

// `include` must be passed explicitly - a real bug in this exact package pairing, confirmed by
// reading vite-plugin-babel@1.7+'s own source: its `include` option (which actually gates
// whether its `transform` hook runs at all) now defaults to /\.jsx?$/ when omitted, and is
// applied BEFORE `rectify()`'s own `filter: /\.[jt]sx$/` narrows anything further - so a bare
// `rectify()` (matching this project's own docs example) silently never transforms a single
// .tsx file. Without this, Vite's own esbuild step handles the untouched JSX itself, using
// tsconfig's react-jsx/jsxImportSource settings below to target a `jsxDEV` export
// @rectify-dev/core's jsx-dev-runtime doesn't actually have ("does not provide an export named
// 'jsxDEV'") - and even patched around that, the JSX would fall back to esbuild's classic
// React.createElement transform instead of Rectify's own runtime ("React is not defined").
const VITE_CONFIG_TS = `import { defineConfig } from "vite";
import rectify from "@rectify-dev/vite-plugin";

export default defineConfig({
  plugins: [rectify({ include: /\\.[jt]sx$/ })],
});
`;

/** Patches whichever tsconfig actually declares `compilerOptions` for `src/` with Rectify's own
 * documented JSX settings (https://rectify-teams.github.io/rectify/learn/installation) — Vite's
 * "react-ts" template splits config across tsconfig.app.json (the app code) and
 * tsconfig.node.json (vite.config.ts itself); older template shapes use one flat tsconfig.json.
 * A real scaffolded tsconfig has `/* Linting *‍/`-style comments (valid JSONC, not valid JSON), so
 * this is a targeted string insertion rather than a JSON.parse/stringify round-trip — the latter
 * throws on the very first comment it hits. react-ts's own tsconfig.app.json already sets
 * `"jsx": "react-jsx"` (with no `jsxImportSource`, defaulting to "react") - stripped first so this
 * doesn't leave a duplicate `"jsx"` key behind. */
async function patchTsconfigForRectify(projectPath: string): Promise<void> {
  const wc = getWcvmInstance();
  const appConfigPath = (await wc.fs.exists(`${projectPath}/tsconfig.app.json`))
    ? `${projectPath}/tsconfig.app.json`
    : `${projectPath}/tsconfig.json`;
  const text = new TextDecoder().decode(await wc.fs.readFile(appConfigPath));
  const withoutExistingJsx = text.replace(/\s*"jsx"\s*:\s*"[^"]*",?/, "");
  const patched = withoutExistingJsx.replace(
    /"compilerOptions"\s*:\s*{/,
    '"compilerOptions": {\n    "jsx": "react-jsx",\n    "jsxImportSource": "@rectify-dev/core",',
  );
  await wc.fs.writeFile(appConfigPath, patched);
}

/** Rectify (https://rectify-teams.github.io/rectify) — a from-scratch UI framework with a
 * React-like hooks/JSX API but zero React dependency — has no official create-vite template, so
 * this starts from Vite's own "react-ts" scaffold (chosen specifically so the landing page - hero
 * image, counter, docs/social sections, all its CSS - looks and feels the same as a fresh React
 * project's own, per the user's own ask) and then follows Rectify's own documented "Manual Setup"
 * on top of it: swap `react`/`react-dom`/`@types/react*`/`@vitejs/plugin-react` for
 * `@rectify-dev/core` + `@rectify-dev/vite-plugin`, swap the Vite config for the `rectify()`
 * plugin, set the TS `jsx`/`jsxImportSource` compiler options, and replace the two React-specific
 * entry files with a Rectify-flavored main/App pair reusing the scaffold's own assets/CSS -
 * landing in the editor the same "exactly like the real thing" way createViteTemplateProject
 * already gives React/Vue.
 */
const createRectifyTemplateProject = async (
  projectPath: string,
  onProgress?: (message: string) => void,
): Promise<RectifyTemplateCreationResult> => {
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
  if (await tryCloneFromCache("rectify", projectPath)) {
    return { isFailure: false, message: "ok" };
  }

  onProgress?.("Scaffolding a Vite + Rectify + TypeScript base…");
  const created = await wc.spawn(
    "npm",
    [
      "create",
      "vite@latest",
      projectPath.slice(1),
      "--",
      "--template",
      "react-ts",
      "--no-interactive",
    ],
    { cwd: "/" },
  );
  const createdLog = await collectText(created);
  const createdExit = await created.exit;
  if (createdExit.exitCode !== 0) {
    return { isFailure: true, message: `npm create vite failed:\n${createdLog.trim()}` };
  }

  onProgress?.("Wiring up Rectify (@rectify-dev/core, @rectify-dev/vite-plugin)…");
  const pkgPath = `${projectPath}/package.json`;
  const pkg = JSON.parse(new TextDecoder().decode(await wc.fs.readFile(pkgPath)));
  delete pkg.dependencies?.react;
  delete pkg.dependencies?.["react-dom"];
  delete pkg.devDependencies?.["@types/react"];
  delete pkg.devDependencies?.["@types/react-dom"];
  delete pkg.devDependencies?.["@vitejs/plugin-react"];
  pkg.dependencies = { ...pkg.dependencies, "@rectify-dev/core": "latest" };
  pkg.devDependencies = { ...pkg.devDependencies, "@rectify-dev/vite-plugin": "latest" };
  pinVitePackage(pkg);
  await wc.fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2));
  await wc.fs.writeFile(`${projectPath}/vite.config.ts`, VITE_CONFIG_TS);
  await patchTsconfigForRectify(projectPath);

  // react-ts's own entry files (main.tsx/App.tsx) are replaced with Rectify-flavored ones above;
  // its own react.svg is swapped for the real Rectify logo (RECTIFY_LOGO_SVG) at the same path
  // shape - everything else (App.css, index.css, hero.png, vite.svg, public/icons.svg,
  // favicon.svg) is kept exactly as react-ts scaffolds it.
  if (await wc.fs.exists(`${projectPath}/src/assets/react.svg`)) {
    await wc.fs.rm(`${projectPath}/src/assets/react.svg`);
  }
  await wc.fs.writeFile(`${projectPath}/src/assets/rectify.svg`, RECTIFY_LOGO_SVG);
  await wc.fs.writeFile(`${projectPath}/src/main.tsx`, MAIN_TSX);
  await wc.fs.writeFile(`${projectPath}/src/App.tsx`, APP_TSX);

  onProgress?.("Installing dependencies from the npm registry (about 10s)…");
  const install = await wc.spawn("npm", ["install"], { cwd: projectPath });
  const installLog = await collectText(install);
  const installExit = await install.exit;
  if (installExit.exitCode !== 0) {
    return { isFailure: true, message: `npm install failed:\n${installLog.trim()}` };
  }

  // OPFS persistence (boot({persist})) is write-behind - without this, a reload right after
  // "created" reports success could still lose files npm install just wrote but hadn't finished
  // mirroring yet (see wc.fs.sync()'s own doc comment). A no-op when persistence isn't enabled.
  await wc.fs.sync();

  // Fire-and-forget, AFTER the real project is already synced and reported - see
  // populateCache's own comment for why folding this into the sync() above would be wrong.
  void populateCache("rectify", projectPath);

  return { isFailure: false, message: "ok" };
};

export { createRectifyTemplateProject };
