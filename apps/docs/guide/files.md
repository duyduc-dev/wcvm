# Files and persistence

wcvm has one in-memory filesystem, shared by every process and by `wc.fs`. It starts **empty**: there is no `/tmp` and no `/home`. Create what your tools need (some packages call `realpath("/tmp")` when they load).

## Reading and writing

```ts
await wc.fs.mkdir("/app/src", { recursive: true });           // writeFile does not create parents
await wc.fs.writeFile("/app/src/main.js", "console.log(1)");
const text = new TextDecoder().decode(await wc.fs.readFile("/app/src/main.js"));
console.log(await wc.fs.readdir("/app/src"));                  // ["main.js"]
```

Errors reject with a `WcvmError` whose `code` is the errno (`ENOENT`, `EEXIST`, `ENOTDIR`, ...). Large reads and writes are chunked internally.

## Seeding a project with `mount`

```ts
await wc.fs.mount({
  "package.json": { file: { contents: '{"name":"app"}' } },
  src: {
    directory: {
      "main.js": { file: { contents: "console.log(1)" } },
      "latest.js": { symlink: "./main.js" },
    },
  },
}, "/app");
```

A node is `{ file: { contents } }`, `{ directory: tree }` or `{ symlink: target }`. `contents` is a string or a `Uint8Array`.

## Downloading

`wc.fs.fetch(url, path)` streams a URL into a file on a dedicated worker, with up to 10 downloads in flight. It is what the built-in `npm install` uses. It rejects, and does not write the file, on a non-2xx status or a network error.

## Persistence (OPFS)

```ts
const wc = boot({ persist: true });
```

With `persist`, every change is mirrored to the browser's Origin Private File System **write-behind**, and restored before the first call is served on the next load. It must be chosen at `boot()`.

- **Write-behind.** A call returns before its OPFS write finishes. Before anything that could lose recent writes (closing the tab right after an `npm install`), call `await wc.fs.sync()`. It resolves once everything so far has landed.
- **Storage root.** `persist: true` uses a default root. Two wcvm instances on one origin share storage unless you name them: `persist: { root: "my-app" }`.
- **Symlinks** are persisted through a side manifest, because OPFS has none.
- **Lazy restore.** By default every persisted file is read back into memory before `ready`. If your projects live under one parent (for example `/home/user/projects/<name>`), set `lazyDepth` to that depth (here `4`). Only the directory structure is restored up front, and each project is restored the first time something touches a path under it.
- **Several tabs.** Tabs of one origin write the same OPFS files, and the browser may refuse one writer while another holds a file (`NoModificationAllowedError`). wcvm retries a refused delete briefly, but keep one tab per project.

## Reset

`await wc.fs.reset()` removes everything under `/` and, when persistence is on, the persisted copy too.
