import type { IFsClient } from "../fs/fsClient";
import { FileSystemTree } from "../models";
import { WcvmError } from "../errors/WcvmError";

const join = (base: string, name: string) =>
  base === "/" ? `/${name}` : `${base}/${name}`;

/** Recursively creates `tree` under `basePath` (created if missing). */
const mountTree = (fs: IFsClient, tree: FileSystemTree, basePath = "/"): void => {
  fs.mkdir(basePath, { recursive: true });

  for (const [name, node] of Object.entries(tree)) {
    if (name === "" || name === "." || name === ".." || name.includes("/")) {
      throw new WcvmError("WcvmError", `Invalid file name in tree: "${name}"`, {
        code: "EINVAL",
      });
    }
    const path = join(basePath, name);

    if ("file" in node) fs.writeFile(path, node.file.contents);
    else if ("symlink" in node) fs.symlink(node.symlink, path);
    else mountTree(fs, node.directory, path);
  }
};

export { mountTree };
