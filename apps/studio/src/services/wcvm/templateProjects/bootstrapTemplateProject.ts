import { getWcvmInstance } from "@/lib/wcvm";
import { collectText } from "./processUtils";
import { tryCloneFromCache } from "./templateCache";
import { pinVitePackage } from "./vitePins";

export interface BootstrapTemplateCreationResult {
  isFailure: boolean;
  message: string;
  type?: string;
}

// Bootstrap 5 has no official create-vite template, so - same approach as
// rectifyTemplateProject.ts - this starts from Vite's own "vanilla-ts" scaffold and swaps in
// Bootstrap's own index.html/main.ts Vite 8 and the Rolldown
// WASM binding it needs aren't available to wcvm (see vitePins.ts's own comment:
// "no WebAssembly build exists for it in this sandbox"); pinVitePackage() below pins wcvm's own
// known-good Vite 7 + esbuild-wasm/rollup-wasm instead. Bootstrap itself is plain CSS/JS with no
// native dependency of its own, so this should carry over cleanly.
const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Vite + Bootstrap 5</title>
  </head>
  <body>
    <div id="app" class="container py-5"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
`;

const MAIN_TS = `import "bootstrap/dist/css/bootstrap.min.css";
import { Modal } from "bootstrap";

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = \`
  <h1 class="mb-3">Vite + Bootstrap 5</h1>
  <p class="text-muted">Running inside wcvm.</p>
  <button class="btn btn-primary" id="open" type="button">Open modal</button>
  <div class="modal fade" id="demo" tabindex="-1">
    <div class="modal-dialog"><div class="modal-content">
      <div class="modal-header"><h5 class="modal-title">Hello</h5></div>
      <div class="modal-body">Bootstrap's JS works too.</div>
      <div class="modal-footer"><button class="btn btn-secondary" data-bs-dismiss="modal" type="button">Close</button></div>
    </div></div>
  </div>
\`;
const modal = new Modal("#demo");
document.querySelector("#open")!.addEventListener("click", () => modal.show());
`;

const createBootstrapTemplateProject = async (
  projectPath: string,
  onProgress?: (message: string) => void,
): Promise<BootstrapTemplateCreationResult> => {
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
  if (await tryCloneFromCache("bootstrap", projectPath)) {
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

  onProgress?.("Wiring up Bootstrap 5…");
  const pkgPath = `${projectPath}/package.json`;
  const pkg = JSON.parse(new TextDecoder().decode(await wc.fs.readFile(pkgPath)));
  pkg.dependencies = { ...pkg.dependencies, bootstrap: "^5.3.3" };
  pinVitePackage(pkg);
  await wc.fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2));
  await wc.fs.writeFile(`${projectPath}/index.html`, INDEX_HTML);
  await wc.fs.writeFile(`${projectPath}/src/main.ts`, MAIN_TS);
  // vanilla-ts's own starter files - unused once main.ts is replaced above.
  if (await wc.fs.exists(`${projectPath}/src/counter.ts`)) {
    await wc.fs.rm(`${projectPath}/src/counter.ts`);
  }
  if (await wc.fs.exists(`${projectPath}/src/style.css`)) {
    await wc.fs.rm(`${projectPath}/src/style.css`);
  }

  // `npm install` is the slow part: the editor runs it in a visible terminal as soon as the project
  // opens (see IdeController.installDependenciesIfNeeded). Sync what was
  // written so far so a reload right after still has it.
  await wc.fs.sync();

  return { isFailure: false, message: "ok" };
};

export { createBootstrapTemplateProject };
