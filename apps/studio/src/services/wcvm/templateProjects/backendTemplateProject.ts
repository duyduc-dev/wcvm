import { getWcvmInstance } from "@/lib/wcvm";
import { BACKEND_RECIPES, type BackendKind } from "./backendRecipes";
import { tryCloneFromCache } from "./templateCache";

export interface BackendTemplateCreationResult {
  isFailure: boolean;
  message: string;
  type?: string;
}

// The files and scripts are in backendRecipes.ts (and why TypeScript is built with `tsc` there).
const createBackendTemplateProject = async (
  projectPath: string,
  kind: BackendKind,
  onProgress?: (message: string) => void,
): Promise<BackendTemplateCreationResult> => {
  const wc = getWcvmInstance();
  const recipe = BACKEND_RECIPES[kind];

  if (await wc.fs.exists(projectPath)) {
    return { isFailure: true, message: `A project already exists at ${projectPath}`, type: "projectName" };
  }

  onProgress?.("Checking the local template cache…");
  if (await tryCloneFromCache(kind, projectPath)) {
    return { isFailure: false, message: "ok" };
  }

  onProgress?.(`Writing the ${recipe.label} project…`);
  await wc.fs.mkdir(projectPath, { recursive: true });
  for (const [relative, contents] of recipe.files) {
    const target = `${projectPath}/${relative}`;
    await wc.fs.mkdir(target.slice(0, target.lastIndexOf("/")), { recursive: true });
    await wc.fs.writeFile(target, contents);
  }
  await wc.fs.writeFile(
    `${projectPath}/package.json`,
    `${JSON.stringify({ name: projectPath.split("/").at(-1), ...recipe.packageJson }, null, 2)}\n`,
  );

  // `npm install` is the slow part: the editor runs it in a visible terminal as soon as the project
  // opens (see IdeController.installDependenciesIfNeeded). Sync what was
  // written so far so a reload right after still has it.
  await wc.fs.sync();

  return { isFailure: false, message: "ok" };
};

export { createBackendTemplateProject };
