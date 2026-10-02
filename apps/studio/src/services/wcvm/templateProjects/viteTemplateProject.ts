import { getWcvmInstance } from "@/lib/wcvm";
import { collectText } from "./processUtils";
import { tryCloneFromCache } from "./templateCache";
import { pinVitePackage } from "./vitePins";

export interface ViteTemplateCreationResult {
  isFailure: boolean;
  message: string;
  type?: string;
}

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

  onProgress?.("Checking the local template cache…");
  if (await tryCloneFromCache(template, projectPath)) {
    return { isFailure: false, message: "ok" };
  }

  onProgress?.(
    `Scaffolding with npm create vite@latest --template ${template}…`,
  );
  // create-vite's own target-directory argument is relative to its cwd — spawn from "/" with
  // the leading slash stripped so it lands back on `projectPath`.
  const created = await wc.spawn(
    "npm",
    [
      "create",
      "vite@latest",
      projectPath.slice(1),
      "--",
      "--template",
      template,
      "--no-interactive",
    ],
    { cwd: "/" },
  );
  const createdLog = await collectText(created);
  const createdExit = await created.exit;
  if (createdExit.exitCode !== 0) {
    return {
      isFailure: true,
      message: `npm create vite failed:\n${createdLog.trim()}`,
    };
  }

  onProgress?.("Pinning known-good dependency versions…");
  const pkgPath = `${projectPath}/package.json`;
  const pkg = JSON.parse(
    new TextDecoder().decode(await wc.fs.readFile(pkgPath)),
  );
  pinVitePackage(pkg);
  await wc.fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2));

  // `npm install` is the slow part: the editor runs it in a visible terminal as soon as the project
  // opens (see IdeController.installDependenciesIfNeeded). Sync what was
  // written so far so a reload right after still has it.
  await wc.fs.sync();

  return { isFailure: false, message: "ok" };
};

export { createViteTemplateProject };
