# Working with the file system

wcvm has **one in-memory filesystem**, shared by every process and by the `wc.fs` API on your page. A file a program writes is immediately visible to your code, and the other way round. It starts empty: there is no `/tmp` and no `/home`, so create what your tools expect (some packages call `realpath("/tmp")` as they load).

Paths use forward slashes and are absolute from `/`. Everything on `wc.fs` is asynchronous and returns a promise.

## The mental model: a file system tree

A project is described as a nested object. Each key is a file or folder name, and each value says what it is:

```ts
import type { FileSystemTree } from "wcvm";

const tree: FileSystemTree = {
  "package.json": { file: { contents: '{ "name": "app" }' } },
  src: {
    directory: {
      "main.js": { file: { contents: "console.log(1)" } },
      "logo.png": { file: { contents: pngBytes } },         // a Uint8Array for binary data
      "latest.js": { symlink: "./main.js" },                 // a symbolic link
    },
  },
};
```

| Node | Shape |
|---|---|
| File | `{ file: { contents: string \| Uint8Array } }` |
| Directory | `{ directory: FileSystemTree }` |
| Symlink | `{ symlink: "<target>" }` |

Names cannot be empty, `.` or `..`, and cannot contain `/`; `mount` rejects them with `EINVAL`.

## Loading files: `mount`

`mount` creates a whole tree in one call:

```ts
await wc.fs.mount(tree);                // at the root
await wc.fs.mount(tree, "/app");        // under /app
```

Prefer `mount` to a loop of `writeFile` calls whenever you load many files, for example when a page opens a project. It is a single call into the kernel instead of one round trip per file.

- The base path is **created if it is missing** (recursively), so `mount(tree, "/home/user/project")` needs no `mkdir` first.
- Files that already exist are **overwritten**; other files in the same folders are left alone. `mount` merges, it does not replace.
- Mount again later to add or update files while processes are running; a running dev server picks the changes up as it would from a real disk.

### Loading from a server

Fetch your project as JSON in the same shape and mount it:

```ts
const tree = await (await fetch("/templates/vite-react.json")).json();
await wc.fs.mount(tree, "/app");
```

Binary files cannot be expressed in JSON, so encode them (base64) and decode before mounting, as Studio's template recipes do (`apps/studio/src/services/wcvm/templateProjects/fullstackTemplateProject.ts`).

### Exporting a folder back to a tree

There is no built-in export, but the tree format is easy to produce from the `fs` calls:

```ts
import type { FileSystemTree, IFs } from "wcvm";

const readTree = async (fs: IFs, dir: string): Promise<FileSystemTree> => {
  const tree: FileSystemTree = {};
  for (const name of await fs.readdir(dir)) {
    const path = dir === "/" ? `/${name}` : `${dir}/${name}`;
    const info = await fs.lstat(path);                       // lstat: do not follow symlinks
    if (info.kind === "dir") tree[name] = { directory: await readTree(fs, path) };
    else if (info.kind === "symlink") tree[name] = { symlink: await fs.readlink(path) };
    else tree[name] = { file: { contents: await fs.readFile(path) } };
  }
  return tree;
};

const snapshot = await readTree(wc.fs, "/app/src");          // skip node_modules: it can be huge
```

## Reading and writing

```ts
await wc.fs.mkdir("/app/src", { recursive: true });                 // writeFile does not create parents
await wc.fs.writeFile("/app/src/main.js", "console.log(1)");        // string or Uint8Array

const bytes = await wc.fs.readFile("/app/src/main.js");             // Uint8Array
const text = new TextDecoder().decode(bytes);

console.log(await wc.fs.readdir("/app/src"));                       // ["main.js"]
```

`readFile` always returns a `Uint8Array`; decode it yourself. `readdir` returns **names only**: call `stat` on a name to tell a file from a folder.

### The operations

| Call | What it does |
|---|---|
| `readFile(path)` | The file's bytes. |
| `writeFile(path, contents)` | Creates or overwrites. The parent folder must exist. |
| `exists(path)` | `true` or `false`, never throws for a missing path. |
| `readdir(path)` | Names in a folder. |
| `mkdir(path, { recursive })` | `recursive: true` creates missing parents and does not fail if the folder exists. |
| `stat(path)` / `lstat(path)` | `{ kind: "file" \| "dir" \| "symlink", size, mode, mtimeMs, ctimeMs, nlink, ino }`. `lstat` does not follow a symlink. |
| `rm(path, { recursive })` | Deletes. A folder needs `recursive: true`. |
| `rename(from, to)` | Moves a file or folder. |
| `cp(from, to)` | Copies a file, symlink or a whole folder, **inside** the filesystem. `to` must not exist. |
| `symlink(target, path)`, `readlink(path)`, `realpath(path)` | Symbolic links. |
| `chmod(path, mode)` | Sets the mode bits. |
| `mount(tree, basePath)` | Described above. |
| `fetch(url, path)` | Downloads a URL straight into a file. |
| `sync()` | Waits until persistence has caught up. |
| `reset()` | Deletes everything under `/`. |

Reach for `cp` over reading and rewriting whole folders: a copy of an installed project (thousands of files) takes one call and no data crosses into your page.

### Errors

Every call rejects with a `WcvmError`. For a filesystem failure, `error.code` is the errno, the same codes Node uses:

```ts
try {
  await wc.fs.readFile("/missing.txt");
} catch (error) {
  if ((error as { code?: string }).code === "ENOENT") console.log("no such file");
}
```

Common codes: `ENOENT` (not found), `EEXIST` (already exists), `ENOTDIR`, `EISDIR`, `ENOTEMPTY` (a folder `rm` without `recursive`), `EINVAL`.

### Big files

You can read and write files larger than the 1 MiB window the kernel exchanges data through: larger transfers are split into chunks for you. Memory is still memory, though: the whole filesystem lives in your tab, so keep very large assets out of it.

## Downloading

```ts
await wc.fs.fetch("https://example.com/data.json", "/app/data.json");
```

The file is fetched on a dedicated worker and **streamed to disk**, so it never sits whole in memory, with up to 10 downloads in flight. It is what the built-in `npm install` uses for package tarballs. It rejects, and does not create the file, on a non-2xx response or a network error; the folder must already exist. The server must allow the request cross-origin (CORS), like any browser `fetch`.

## Watching for changes

The host API has no `watch`. Inside the sandbox, programs can use `fs.watch` and `fs.watchFile` (real push events), so a dev server reacts to edits as usual. From your page, either poll `stat(path).mtimeMs`, or have a small process report changes:

```ts
await wc.fs.writeFile("/watch.js", `
  require("fs").watch("/app/src", { recursive: true }, (event, name) => console.log(event, name));
`);
const watcher = await wc.spawn("node", ["/watch.js"]);
// read watcher.stdout, stop with watcher.kill()
```

Studio keeps its file explorer current by reloading the folders you have open while a terminal is printing output, and when the editor regains focus.

## Persistence

By default everything is lost when the tab closes. To keep it, mirror the filesystem to the browser's **Origin Private File System** (OPFS), a private per-origin disk:

```ts
const wc = boot({ persist: true });
```

With `persist`, every change is written to OPFS **in the background** and restored before the first call is served on the next load. Choose it at `boot()`; it cannot be switched on later.

### Write-behind and `sync()`

A call returns before its OPFS write finishes. If you are about to lose the page (a "Save and close" button, a reload) after a big write such as an `npm install`, wait for the mirror to catch up:

```ts
await wc.fs.sync();       // resolves once every change so far has landed in OPFS
```

Without it, a reload straight after an install can lose the last files. Where persistence is off, `sync()` resolves immediately.

### Options

```ts
boot({ persist: { root: "my-app", lazyDepth: 4, exclude: ["node_modules"] } });
```

| Option | |
|---|---|
| `root` | The storage name. Two wcvm instances on one origin share storage unless you name them. Default: `"wcvm"`. |
| `lazyDepth` | Restore lazily. By default every persisted file is read back into memory before `ready`, which gets slow once users accumulate projects. If projects live under one parent (for example `/home/user/projects/<name>`), set `lazyDepth` to the depth of a project folder (here `4`): only the folder structure is restored up front, and each project is restored the first time something touches a path under it. |
| `exclude` | Names that are **never persisted**, at any depth: `["node_modules"]`. See below. |

### Keep `node_modules` out of storage

Installed packages are thousands of small files that `npm install` can recreate, and mirroring them is the slowest part of saving a project. List them in `exclude`:

```ts
const wc = boot({ persist: { lazyDepth: 4, exclude: ["node_modules"] } });
```

Anything under a folder or file with that name stays in memory for the session and is simply absent after a reload. So your app must **run `npm install` when it opens a project that has dependencies and no `node_modules`**:

```ts
const hasModules = await wc.fs.exists("/app/node_modules");
if (!hasModules) {
  const install = await wc.spawn("npm", ["install"], { cwd: "/app" });
  if ((await install.exit).exitCode !== 0) {
    await wc.fs.rm("/app/node_modules", { recursive: true }).catch(() => {});   // do not keep a half install
  }
}
```

Anything already persisted under an excluded name before you turned this on is not restored and is removed from OPFS. [Studio](https://studio.wcvmjs.com) works exactly like this: it opens a terminal and runs the install for you.

### Things to know about OPFS

- **Symlinks** are persisted through a side manifest, because OPFS has none.
- **Several tabs** of one origin write the same files, and the browser may refuse one writer while another holds a file (`NoModificationAllowedError`). wcvm retries a refused delete briefly. Keep one tab per project.
- **Quota.** The browser decides how much an origin may store, and can evict it under pressure. Treat persistence as a cache of a project you can recreate, not as the only copy.
- **Private windows** may have no OPFS, or discard it when closed.

## Reset

```ts
await wc.fs.reset();
```

Removes everything under `/` and, when persistence is on, the persisted copy as well. Use it for a "clear all my projects" button.
