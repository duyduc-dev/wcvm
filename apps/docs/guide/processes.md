# Processes, shell and npm

## Processes

Every process runs in its own Web Worker. `wc.spawn(command, args, { cwd, env })` starts one and returns `{ processId, stdout, stderr, stdin, exit, kill }` (see the [API reference](/reference/api#spawn)).

Output is a `ReadableStream<Uint8Array>` and stdin is a `WritableStream<Uint8Array>`:

```ts
const pump = async (stream: ReadableStream<Uint8Array>, write: (s: string) => void) => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    write(decoder.decode(value, { stream: true }));
  }
};

const proc = await wc.spawn("node", ["server.js"], { cwd: "/app" });
void pump(proc.stdout, (text) => terminal.write(text));        // for example xterm.js
void pump(proc.stderr, (text) => terminal.write(text));

const writer = proc.stdin.getWriter();                          // feed it input
await writer.write(new TextEncoder().encode("hello\n"));
await writer.close();                                           // end of input
```

Output is buffered until you read it, so a process that writes a lot and is never read keeps that memory.

### Interactive programs

Programs that read stdin (`sh`, `node` with no script, anything using `readline`) get a real, open stdin. Wire a terminal to `stdin` and `stdout` and they behave interactively. There is **no pty**: wcvm's shell and REPL read whole lines and do not echo, so the terminal widget does line editing and echo itself. Studio's terminal (in `apps/studio`) is a working example.

### Killing

`proc.kill()` stops the process **and everything it spawned**; `kill("SIGKILL")` exits 137, the default `SIGTERM` exits 143. A dev server started from a shell is a child of that shell's process, so killing the shell frees its ports.

There is no `SIGINT`. A command run from a shell runs inside that shell's own worker, so Ctrl+C cannot interrupt it without leaving its listeners and globals behind. End the shell and start a new one instead, as Studio's terminal does.

## Built-in commands

`echo cat ls pwd mkdir rm sleep clear true false node sh npm`. Anything else is looked up on `PATH` (and `node_modules/.bin` when run through `npm run`), including scripts with a `#!/usr/bin/env node` shebang. An unknown command exits 127.

## node

`node script.js [args]`, `node -e "code"`, or `node` alone for an interactive REPL. See [Limitations](/reference/limitations) for where it differs from real Node.

## sh

`sh -c "..."`, `sh script.sh`, or `sh` alone for an interactive shell.

Supported: `;` `&&` `||` sequencing, `|` pipes, `>` `>>` `<` redirects including file-descriptor redirects (`2>&1`, `>&2`, `&>`, `2>/dev/null`), and `cd`.

Not supported: `$` expansion, globbing, subshells, control flow (`if`, `for`, ...) and `&` background jobs. A syntax error on one interactive line is reported and the session continues.

## npm

A deliberately small built-in, **not real npm**:

```
npm install [<package>[@<version|range|tag>] ...] [--save-dev|-D] [--registry=<url>]
npm run [<script>] [-- <args>...] [--if-present] [--ignore-scripts]
npm start | stop | restart | test [-- <args>...]
npm create <name>[@<version>] [-- <args>...]
npm --version
```

- **install** reads `package.json` (or the named packages) and installs from the real registry (`registry.npmjs.org`, or `--registry`) into `node_modules`, saving dependencies to `package.json`. There is **no lockfile, no lifecycle (`postinstall`) scripts, and no git, file or workspace dependencies**. A package that needs its `postinstall` needs that step done by you.
- **run** executes `package.json` scripts through `sh`, with `node_modules/.bin` on `PATH`.
- **create** fetches `create-<name>` and runs its bin, like `npx create-<name>`. The bare, interactive `npm init` wizard is not supported.
- `npx <bin>` runs a binary that is already installed. It does not fetch from the registry.

Some bundlers and toolchains are swapped for WebAssembly builds so they run in a browser. See [Frameworks](/guide/frameworks) for the pins that matter.
