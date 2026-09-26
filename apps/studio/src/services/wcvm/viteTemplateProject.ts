import { getWcvmInstance } from "@/lib/wcvm";
import { collectText } from "./processUtils";
import { pinVitePackage } from "./vitePins";

export interface ViteTemplateCreationResult {
  isFailure: boolean;
  message: string;
  type?: string;
}

/** Scaffolds a REAL Vite project with `npm create vite@latest --template <template>` — not a
 * hand-written file tree — then pins the same known-working dependency versions wcvm's own
 * playground examples already found necessary and installs them for real from the npm registry,
 * so the project that lands in the editor is exactly what running that command yourself would
 * produce, minus the version substitutions this sandbox needs to actually run it.
 */
const createViteTemplateProject = async (
  projectPath: string,
  template: string,
  onProgress?: (message: string) => void,
): Promise<ViteTemplateCreationResult> => {
  const wc = getWcvmInstance();

  const isExisting = await wc.fs.exists(projectPath);
  if (isExisting) {
    return {
      isFailure: true,
      message: `A project already exists at ${projectPath}`,
      type: "projectName",
    };
  }

  onProgress?.(`Scaffolding with npm create vite@latest --template ${template}…`);
  // create-vite's own target-directory argument is relative to its cwd — spawn from "/" with
  // the leading slash stripped so it lands back on `projectPath`.
  const created = await wc.spawn(
    "npm",
    ["create", "vite@latest", projectPath.slice(1), "--", "--template", template, "--no-interactive"],
    { cwd: "/" },
  );
  const createdLog = await collectText(created);
  const createdExit = await created.exit;
  if (createdExit.exitCode !== 0) {
    return { isFailure: true, message: `npm create vite failed:\n${createdLog.trim()}` };
  }

  onProgress?.("Pinning known-good dependency versions…");
  const pkgPath = `${projectPath}/package.json`;
  const pkg = JSON.parse(new TextDecoder().decode(await wc.fs.readFile(pkgPath)));
  pinVitePackage(pkg);
  await wc.fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2));

  onProgress?.("Installing dependencies from the npm registry (about 10s)…");
  const install = await wc.spawn("npm", ["install"], { cwd: projectPath });
  const installLog = await collectText(install);
  const installExit = await install.exit;
  if (installExit.exitCode !== 0) {
    return { isFailure: true, message: `npm install failed:\n${installLog.trim()}` };
  }

  return { isFailure: false, message: "ok" };
};

export { createViteTemplateProject };
