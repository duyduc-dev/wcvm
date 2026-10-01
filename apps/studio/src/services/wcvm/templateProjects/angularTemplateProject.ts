import { getWcvmInstance } from "@/lib/wcvm";
import { ANGULAR_FILES, ANGULAR_PACKAGE_JSON, ANGULAR_POST_INSTALL_FILES } from "./angularRecipe";
import { collectText } from "./processUtils";
import { populateCache, tryCloneFromCache } from "./templateCache";

export interface AngularTemplateCreationResult {
  isFailure: boolean;
  message: string;
  type?: string;
}

// The recipe itself (files, pins, and everything that had to be true for it to run) is in
// angularRecipe.ts - kept import-free of the app so the Playwright test runs exactly the same files.
const createAngularTemplateProject = async (
  projectPath: string,
  onProgress?: (message: string) => void,
): Promise<AngularTemplateCreationResult> => {
  const wc = getWcvmInstance();

  if (await wc.fs.exists(projectPath)) {
    return { isFailure: true, message: `A project already exists at ${projectPath}`, type: "projectName" };
  }

  onProgress?.("Checking the local template cache…");
  if (await tryCloneFromCache("angular", projectPath)) {
    return { isFailure: false, message: "ok" };
  }

  onProgress?.("Writing the Angular project…");
  await wc.fs.mkdir("/tmp", { recursive: true });
  for (const [relative, contents] of ANGULAR_FILES) {
    const target = `${projectPath}/${relative}`;
    await wc.fs.mkdir(target.slice(0, target.lastIndexOf("/")), { recursive: true });
    await wc.fs.writeFile(target, contents);
  }
  await wc.fs.writeFile(
    `${projectPath}/package.json`,
    JSON.stringify({ ...ANGULAR_PACKAGE_JSON, name: projectPath.split("/").at(-1) }, null, 2),
  );

  onProgress?.("Installing dependencies from the npm registry (about 30s)…");
  const install = await wc.spawn("npm", ["install"], { cwd: projectPath });
  const installLog = await collectText(install);
  const installExit = await install.exit;
  if (installExit.exitCode !== 0) {
    return { isFailure: true, message: `npm install failed:\n${installLog.trim()}` };
  }

  onProgress?.("Patching oxc-parser for this sandbox…");
  const oxcDir = `${projectPath}/node_modules/oxc-parser`;
  if (await wc.fs.exists(oxcDir)) await wc.fs.rm(oxcDir, { recursive: true });
  for (const [relative, contents] of ANGULAR_POST_INSTALL_FILES) {
    const target = `${projectPath}/${relative}`;
    await wc.fs.mkdir(target.slice(0, target.lastIndexOf("/")), { recursive: true });
    await wc.fs.writeFile(target, contents);
  }

  // See createViteTemplateProject's own comments on these two calls. The cached copy includes the
  // oxc-parser stub (populateCache clones the whole directory), so a clone never re-patches.
  await wc.fs.sync();
  void populateCache("angular", projectPath);

  return { isFailure: false, message: "ok" };
};

export { createAngularTemplateProject };
