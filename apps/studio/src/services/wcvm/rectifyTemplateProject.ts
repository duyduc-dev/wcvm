import { getWcvmInstance } from "@/lib/wcvm";
import { collectText } from "./processUtils";
import { pinVitePackage } from "./vitePins";

export interface RectifyTemplateCreationResult {
  isFailure: boolean;
  message: string;
  type?: string;
}

const APP_TSX = `import { useState } from "@rectify-dev/core";
import "./style.css";

function App() {
  const [count, setCount] = useState(0);

  return (
    <div className="card">
      <h1>Rectify + TypeScript</h1>
      <button onClick={() => setCount((c) => c + 1)}>count is {count}</button>
      <p>
        Edit <code>src/App.tsx</code> and save to test HMR
      </p>
    </div>
  );
}

export default App;
`;

const MAIN_TSX = `import { createRoot } from "@rectify-dev/core";
import App from "./App";
import "./style.css";

createRoot(document.getElementById("root")!).render(<App />);
`;

const VITE_CONFIG_TS = `import { defineConfig } from "vite";
import rectify from "@rectify-dev/vite-plugin";

export default defineConfig({
  plugins: [rectify()],
});
`;

/** Patches whichever tsconfig actually declares `compilerOptions` for `src/` with Rectify's own
 * documented JSX settings (https://rectify-teams.github.io/rectify/learn/installation) — Vite's
 * "vanilla-ts" template splits config across tsconfig.app.json (the app code) and
 * tsconfig.node.json (vite.config.ts itself); older template shapes use one flat tsconfig.json.
 * A real scaffolded tsconfig has `/* Linting *‍/`-style comments (valid JSONC, not valid JSON), so
 * this is a targeted string insertion rather than a JSON.parse/stringify round-trip — the latter
 * throws on the very first comment it hits. */
async function patchTsconfigForRectify(projectPath: string): Promise<void> {
  const wc = getWcvmInstance();
  const appConfigPath = (await wc.fs.exists(`${projectPath}/tsconfig.app.json`))
    ? `${projectPath}/tsconfig.app.json`
    : `${projectPath}/tsconfig.json`;
  const text = new TextDecoder().decode(await wc.fs.readFile(appConfigPath));
  const patched = text.replace(
    /"compilerOptions"\s*:\s*{/,
    '"compilerOptions": {\n    "jsx": "react-jsx",\n    "jsxImportSource": "@rectify-dev/core",',
  );
  await wc.fs.writeFile(appConfigPath, patched);
}

/** Rectify (https://rectify-teams.github.io/rectify) — a from-scratch UI framework with a
 * React-like hooks/JSX API but zero React dependency — has no official create-vite template, so
 * this starts from Vite's own "vanilla-ts" scaffold (a real, already-proven base in this sandbox)
 * and then follows Rectify's own documented "Manual Setup" on top of it: install
 * `@rectify-dev/core` + `@rectify-dev/vite-plugin`, swap the Vite config for the `rectify()`
 * plugin, set the TS `jsx`/`jsxImportSource` compiler options, and replace the vanilla entry
 * files with a JSX main/App pair — landing in the editor the same "exactly like the real thing"
 * way createViteTemplateProject already gives React/Vue.
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

  onProgress?.("Wiring up Rectify (@rectify-dev/core, @rectify-dev/vite-plugin)…");
  const pkgPath = `${projectPath}/package.json`;
  const pkg = JSON.parse(new TextDecoder().decode(await wc.fs.readFile(pkgPath)));
  pkg.dependencies = { ...pkg.dependencies, "@rectify-dev/core": "latest" };
  pkg.devDependencies = { ...pkg.devDependencies, "@rectify-dev/vite-plugin": "latest" };
  pinVitePackage(pkg);
  await wc.fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2));
  await wc.fs.writeFile(`${projectPath}/vite.config.ts`, VITE_CONFIG_TS);
  await patchTsconfigForRectify(projectPath);

  // vanilla-ts's own demo files (plain TS, no JSX) are replaced with Rectify's own main/App
  // pair — mirroring what a fresh react-ts scaffold already gives the React/Vue templates.
  if (await wc.fs.exists(`${projectPath}/src/counter.ts`)) {
    await wc.fs.rm(`${projectPath}/src/counter.ts`);
  }
  if (await wc.fs.exists(`${projectPath}/src/main.ts`)) {
    await wc.fs.rm(`${projectPath}/src/main.ts`);
  }
  await wc.fs.writeFile(`${projectPath}/src/main.tsx`, MAIN_TSX);
  await wc.fs.writeFile(`${projectPath}/src/App.tsx`, APP_TSX);

  const indexHtmlPath = `${projectPath}/index.html`;
  const indexHtml = new TextDecoder().decode(await wc.fs.readFile(indexHtmlPath));
  await wc.fs.writeFile(
    indexHtmlPath,
    indexHtml.replace('src="/src/main.ts"', 'src="/src/main.tsx"'),
  );

  onProgress?.("Installing dependencies from the npm registry (about 10s)…");
  const install = await wc.spawn("npm", ["install"], { cwd: projectPath });
  const installLog = await collectText(install);
  const installExit = await install.exit;
  if (installExit.exitCode !== 0) {
    return { isFailure: true, message: `npm install failed:\n${installLog.trim()}` };
  }

  return { isFailure: false, message: "ok" };
};

export { createRectifyTemplateProject };
