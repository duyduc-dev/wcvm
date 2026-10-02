# Introduction

wcvm is a browser-based runtime for **Node.js projects**. It runs entirely inside a browser tab: your code, `npm install`, a dev server and the preview of that server all live in the page, in Web Workers, with **no backend**.

You give it files, it gives you real processes. A `node server.js` is a Web Worker running Node's own `lib/`. An `npm install` downloads packages from the real npm registry into an in-memory filesystem. A Vite or Next.js dev server starts, listens on a virtual port, and an `<iframe>` on your page shows it, hot reload included.

```ts
import { boot } from "wcvm";

const wc = boot();
await wc.fs.writeFile("/hello.js", `console.log("hello from", process.version)`);
const proc = await wc.spawn("node", ["hello.js"]);
console.log(await new Response(proc.stdout).text());     // hello from v24.18.0
```

## What you can build with it

- **Tutorials and documentation** whose code samples run, and can be edited, in the page. The [playground](/playground) on this site is one.
- **Online IDEs and sandboxes.** [Studio](https://studio.wcvmjs.com) is a full editor, terminal, file explorer and preview built on wcvm.
- **Bug reports and demos** that open already installed and running, with nothing to clone.
- **Code execution for AI products**: a place to run what a model wrote, inside the user's own browser, with nothing sent to a server.
- **Teaching tools** where every student gets the same, disposable environment.

## What is inside

| | |
|---|---|
| **Real processes** | One Web Worker per process, with `stdout`, `stderr`, `stdin`, an exit code and `kill()`. A child process is another worker, supervised by the kernel. |
| **Node's own runtime** | Node v24's `lib/` is vendored unmodified on a small native layer written for the browser, so `fs`, `stream`, `http`, `net`, `child_process`, `zlib`, ESM and `require(esm)` behave like Node. |
| **A filesystem** | One in-memory filesystem shared by every process and by the host API, optionally mirrored to the browser's Origin Private File System. |
| **A shell and npm** | `sh` with pipes and redirects, and a small built-in `npm` that installs from the registry and runs scripts. |
| **A virtual network** | `net`, `http` and `dgram` between sandbox processes, and a Service Worker that relays an `<iframe>` (WebSockets included) to a server in the sandbox. |
| **Frameworks** | Vite (React, Vue, Svelte, ...), Next.js, SvelteKit, React Router 7, Astro, Angular, Ember, Express and NestJS, each checked in a real browser. See [Frameworks](/guide/frameworks). |

## Why not a cloud sandbox

A server-side sandbox (a container or a VM per user) works, and wcvm is not a replacement for one when you need a real kernel, native binaries or arbitrary network access. The trade-offs:

| | A cloud sandbox | wcvm |
|---|---|---|
| **Startup** | Seconds to start a machine, and a round trip for every command. | Starts in the page. Commands do not leave the browser. |
| **Cost** | You pay for every running machine, including idle ones. | The user's browser does the work. A static site hosts it. |
| **Scale** | Capacity you provision. | One more user is one more tab. |
| **Isolation** | You must contain untrusted code on your own infrastructure. | Code runs in the browser's own sandbox: no access to your servers, and none to the user's machine beyond the page. |
| **Offline** | Needs a connection to a machine. | Works offline once the page and the packages are loaded. |
| **Native code** | Anything Linux runs. | WebAssembly only. No `.node` add-ons, no arbitrary binaries. |
| **Network** | Real sockets. | A virtual network between sandbox processes. Only `npm` and `wc.fs.fetch` reach the internet. |

## Is it right for my project

Use wcvm when your project is **JavaScript or TypeScript on Node**, its tools have WebAssembly builds (or are pure JavaScript), and a few seconds of `npm install` in the page is acceptable.

Look elsewhere when you need native add-ons, Python or other runtimes, a real database server, or full TCP/UDP to the outside world. [Limitations](/reference/limitations) lists exactly what differs from real Node.

::: tip Coming from WebContainers?
The API has the same shape (`boot`, `mount`, `fs`, `spawn`) with a few differences. See [Migrating from WebContainers](/guide/from-webcontainers).
:::

## Where to start

1. [**Quickstart**](/guide/getting-started): from nothing to a dev server in an `<iframe>`.
2. [**Working with the file system**](/guide/files): seed, read, write, persist.
3. [**Running processes**](/guide/processes): streams, input, a terminal, the shell and npm.
4. [**Preview a dev server**](/guide/preview): how the iframe reaches your server.
5. [**Configuring headers**](/guide/headers): the isolation headers your host page must send.
6. [**Browser support**](/guide/browser-support) and [**Troubleshooting**](/guide/troubleshooting).

Or try it first: the [playground](/playground) runs in this page, and [Studio](https://studio.wcvmjs.com) is the complete experience.
