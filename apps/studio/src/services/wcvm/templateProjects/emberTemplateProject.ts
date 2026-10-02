import { getWcvmInstance } from "@/lib/wcvm";
import { buildEmberFiles, buildEmberPackageJson } from "./emberRecipe";
import { tryCloneFromCache } from "./templateCache";

export interface EmberTemplateCreationResult {
  isFailure: boolean;
  message: string;
  type?: string;
}

// The recipe itself (files, pins, why) is in emberRecipe.ts - kept import-free of the app so the
// Playwright test can run exactly the same files.

const createEmberTemplateProject = async (
  projectPath: string,
  typescript: boolean,
  onProgress?: (message: string) => void,
): Promise<EmberTemplateCreationResult> => {
  const wc = getWcvmInstance();
  const kind = typescript ? "ember-ts" : "ember";

  if (await wc.fs.exists(projectPath)) {
    return { isFailure: true, message: `A project already exists at ${projectPath}`, type: "projectName" };
  }

  onProgress?.("Checking the local template cache…");
  if (await tryCloneFromCache(kind, projectPath, { keepPackageName: true })) {
    return { isFailure: false, message: "ok" };
  }

  onProgress?.("Writing the Ember project…");
  await wc.fs.mkdir("/tmp", { recursive: true });
  for (const [relative, contents] of buildEmberFiles(typescript)) {
    const target = `${projectPath}/${relative}`;
    await wc.fs.mkdir(target.slice(0, target.lastIndexOf("/")), { recursive: true });
    await wc.fs.writeFile(target, contents);
  }
  const pkg = buildEmberPackageJson(typescript);
  await wc.fs.writeFile(`${projectPath}/package.json`, JSON.stringify(pkg, null, 2));

  // `npm install` is the slow part: the editor runs it in a visible terminal as soon as the project
  // opens (see IdeController.installDependenciesIfNeeded). Sync what was
  // written so far so a reload right after still has it.
  await wc.fs.sync();

  return { isFailure: false, message: "ok" };
};

export { createEmberTemplateProject };
