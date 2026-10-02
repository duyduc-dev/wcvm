import { getWcvmInstance } from "@/lib/wcvm";
import type { IWcvmProjectType } from "../model";
import { collectText } from "./processUtils";
import { patchAngularAfterInstall } from "./angularTemplateProject";
import { linkFullstackAfterInstall } from "./fullstackTemplateProject";
import { patchOxideForBrowser, patchTailwindVitePluginOnDisk } from "./tailwindTemplateProject";
import { populateCache } from "./templateCache";

const TYPEGEN_TIMEOUT_MS = 30_000;

/** `LayoutProps` / `PageProps` are globals Next writes to `.next/types` - normally the first
 *  `next dev` does. Run `next typegen` now so the editor knows them right after the install.
 *  Best effort: a failure only means the types appear once the dev server has started. */
const generateNextTypes = async (projectPath: string): Promise<void> => {
  const wc = getWcvmInstance();
  try {
    const typegen = await wc.spawn("npx", ["next", "typegen"], { cwd: projectPath });
    const timer = setTimeout(() => typegen.kill(), TYPEGEN_TIMEOUT_MS);
    try {
      await Promise.all([collectText(typegen), typegen.exit]);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    /* see above */
  }
};

/** What a template needs after its `npm install` has succeeded - the patches and links the old
 *  create-time install used to apply inline. Resolves to an error message, or null when done. */
const finishTemplateInstall = async (type: IWcvmProjectType, projectPath: string): Promise<string | null> => {
  const wc = getWcvmInstance();
  switch (type) {
    case "angular":
      await patchAngularAfterInstall(projectPath);
      break;
    case "tailwind":
      if (!(await patchOxideForBrowser(projectPath))) {
        return "@tailwindcss/oxide-wasm32-wasi wasn't installed - cannot patch it for this sandbox.";
      }
      if (!(await patchTailwindVitePluginOnDisk(projectPath))) {
        return "@tailwindcss/vite wasn't installed where expected - cannot patch it for this sandbox.";
      }
      break;
    case "nextjs":
    case "nextjs-ts":
    case "sveltekit":
    case "react-router":
    case "astro":
      await linkFullstackAfterInstall(projectPath, type);
      if (type === "nextjs" || type === "nextjs-ts") await generateNextTypes(projectPath);
      break;
  }
  await wc.fs.sync();
  // Fire-and-forget, after the sync above - see populateCache's own comment. The cached copy is the
  // installed (and patched) project, so the next creation of this template needs no install at all.
  void populateCache(type, projectPath);
  return null;
};

export { finishTemplateInstall };
