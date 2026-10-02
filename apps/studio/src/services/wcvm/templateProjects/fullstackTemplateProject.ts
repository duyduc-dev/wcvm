import { getWcvmInstance } from "@/lib/wcvm";
import { buildFullstackPackageJson, FULLSTACK_RECIPES, type FullstackKind } from "./fullstackRecipes";
import { tryCloneFromCache } from "./templateCache";

export interface FullstackTemplateCreationResult {
  isFailure: boolean;
  message: string;
  type?: string;
}

// The files, pins and per-framework reasoning are in fullstackRecipes.ts.
const createFullstackTemplateProject = async (
  projectPath: string,
  kind: FullstackKind,
  onProgress?: (message: string) => void,
): Promise<FullstackTemplateCreationResult> => {
  const wc = getWcvmInstance();
  const recipe = FULLSTACK_RECIPES[kind];

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
  if (recipe.lazyFiles) {
    const { files, binary } = await recipe.lazyFiles();
    for (const [relative, contents] of files) {
      const target = `${projectPath}/${relative}`;
      await wc.fs.mkdir(target.slice(0, target.lastIndexOf("/")), { recursive: true });
      await wc.fs.writeFile(target, contents);
    }
    for (const [relative, base64] of binary) {
      const target = `${projectPath}/${relative}`;
      await wc.fs.mkdir(target.slice(0, target.lastIndexOf("/")), { recursive: true });
      await wc.fs.writeFile(target, Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));
    }
  }
  const name = projectPath.split("/").at(-1)!;
  await wc.fs.writeFile(`${projectPath}/package.json`, `${JSON.stringify(buildFullstackPackageJson(recipe, name), null, 2)}\n`);

  // `npm install` (and the symlinks that must follow it) runs in the editor's terminal - see
  // finishTemplateInstall in postInstall.ts.
  await wc.fs.sync();

  return { isFailure: false, message: "ok" };
};

/** What a `postinstall` script would do - wcvm's npm never runs lifecycle scripts. */
const linkFullstackAfterInstall = async (projectPath: string, kind: FullstackKind): Promise<void> => {
  const wc = getWcvmInstance();
  for (const { path, target } of FULLSTACK_RECIPES[kind].links ?? []) {
    const link = `${projectPath}/${path}`;
    await wc.fs.mkdir(link.slice(0, link.lastIndexOf("/")), { recursive: true });
    if (!(await wc.fs.exists(link))) await wc.fs.symlink(target, link);
  }
};

export { createFullstackTemplateProject, linkFullstackAfterInstall };
