# Running processes

A wcvm process is a **Web Worker running a program**: `node`, `sh`, `npm` or another built-in. Start one with `spawn`, then read its output, write to its input, wait for it to exit, or kill it.

```ts
const proc = await wc.spawn("node", ["main.js", "--flag"], {
  cwd: "/app",
  env: { NODE_ENV: "development" },
});
```

`spawn(command, args, options)` returns a promise for an object with:

| Member | |
|---|---|
| `processId` | The PID. |
| `stdout`, `stderr` | `ReadableStream<Uint8Array>`. |
| `stdin` | `WritableStream<Uint8Array>`. |
| `exit` | A promise for `{ exitCode, signal?, errorMessage? }`. |
| `kill(signal?)` | Stops the process and everything it started. |

Options: `cwd` (default `/`) and `env`, merged over a small base environment. A command that does not exist exits with status **127**.

## Running a command to completion

The common case, installing dependencies and checking the result:

```ts
const install = await wc.spawn("npm", ["install"], { cwd: "/app" });
const { exitCode } = await install.exit;
if (exitCode !== 0) throw new Error(`npm install exited with ${exitCode}`);
```

Always look at the exit code before the next step. A failed install followed by `npm run dev` fails later, and less clearly.

## Reading output

`stdout` and `stderr` are separate byte streams. Decode as you read; `stream: true` keeps a multi-byte character that is split across two chunks intact:

```ts
const pump = async (stream: ReadableStream<Uint8Array>, write: (text: string) => void) => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    write(decoder.decode(value, { stream: true }));
  }
};

const proc = await wc.spawn("npm", ["run", "build"], { cwd: "/app" });
void pump(proc.stdout, (text) => (output.textContent += text));
void pump(proc.stderr, (text) => (output.textContent += text));
await proc.exit;
```

To collect everything at once, `await new Response(proc.stdout).text()`. Read `stdout` and `stderr` **concurrently** (as above, or with `Promise.all`) if you need both; awaiting one to the end before starting the other works only if the program is not also filling the second.

::: warning Output is buffered until you read it
A process that prints a lot and whose streams are never read keeps all of it in memory. If you do not care about the output, still drain it, or let a short-lived process finish and drop the reference.
:::

The streams close when the process exits, after every chunk has been delivered, so `await pump(...)` followed by `await proc.exit` loses nothing.

## Sending input

```ts
const writer = proc.stdin.getWriter();
await writer.write(new TextEncoder().encode("hello\n"));
await writer.close();                       // end of input: a program reading stdin to the end now finishes
```

stdin stays open until you close it or the process exits; bytes written after exit are dropped. Programs that read stdin (`sh`, `node` with no script, anything using `readline`) get a real, open pipe.

## Waiting for a server

A server never "finishes", so wait for what you care about. wcvm tells you whenever **any** sandbox server starts or stops listening on a virtual port:

```ts
const off = wc.preview.onListen(({ port, listening }) => {
  if (listening) console.log(`server is up on ${port}`);
});

const dev = await wc.spawn("npm", ["run", "dev"], { cwd: "/app" });
```

`onListen` returns an unsubscribe function and does not need `preview.enable()`. To use a port you do not know in advance (Vite picks the next free one), read it from the event. You can also look for the framework's ready line in `stdout`.

Frameworks sometimes bind a port briefly, release it and bind it again (Angular's `ng serve` checks the port first). A page that opens an iframe on the first event should reload it on the next one, as Studio does.

## Environment and working directory

`cwd` is where the process starts, and where relative paths in its arguments resolve. `env` adds variables:

```ts
await wc.spawn("sh", [], {
  cwd: "/app",
  env: { FORCE_COLOR: "3", JOBS: "1" },
});
```

A few variables matter for specific tools (colored output, worker pools that hang): [Frameworks](/guide/frameworks#environment-variables).

## Killing a process

```ts
dev.kill();               // SIGTERM: exit code 143
dev.kill("SIGKILL");      // exit code 137
```

`kill` stops the process **and everything it spawned**. A dev server started from a shell is a child of that shell, so killing the shell frees its ports. Killing an exited process does nothing.

There is **no `SIGINT`**. A command run from a shell runs inside that shell's own worker, so Ctrl+C cannot interrupt it without leaving its listeners and globals behind. A terminal UI should treat Ctrl+C as "end the shell and start a fresh one in the same folder", which is what Studio's terminal does.

## Connecting a terminal

`sh` with no arguments is an interactive shell; `node` with no script is a REPL. Wire a terminal widget such as [xterm.js](https://xtermjs.org) to the process's streams:

```ts
import { Terminal } from "@xterm/xterm";

const term = new Terminal({ convertEol: true });
term.open(document.getElementById("terminal")!);

const shell = await wc.spawn("sh", [], { cwd: "/app" });
void pump(shell.stdout, (text) => term.write(text));
void pump(shell.stderr, (text) => term.write(text));

const writer = shell.stdin.getWriter();
const encoder = new TextEncoder();
let line = "";

// There is no pty: the shell reads whole lines and does not echo, so the terminal does the echo
// and the line editing, and sends a line when the user presses Enter.
term.onData((data) => {
  for (const ch of data) {
    if (ch === "\r") {
      term.write("\r\n");
      void writer.write(encoder.encode(line + "\n"));
      line = "";
    } else if (ch === "\x7f") {                         // backspace
      if (line) {
        line = line.slice(0, -1);
        term.write("\b \b");
      }
    } else if (ch >= " ") {
      line += ch;
      term.write(ch);
    }
  }
});
```

Studio's terminal is a fuller version of this (cursor movement, history, tab completion, Ctrl+C handling, copy and paste): `apps/studio/src/features/Editor/ide/controller/terminal.service.ts` in the repository.

::: tip Pasting into xterm
xterm turns Ctrl+V into a control character and cancels the key event, so the browser never pastes. Hand it back with `term.attachCustomKeyEventHandler((e) => !(e.type === "keydown" && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v"))`.
:::

## Child processes

A process can start others with Node's `child_process` (`spawn`, `exec`, `execFile`, `execSync`, `spawnSync`, `fork` with IPC). Each child is another worker, supervised by the kernel and killed with its parent. `detached` is accepted but not honored.

## Built-in commands

`echo cat ls pwd mkdir rm sleep clear true false node sh npm`. Anything else is looked up on `PATH` (and `node_modules/.bin` when run through `npm run`), including scripts with a `#!/usr/bin/env node` shebang. An unknown command exits 127.

## node

```
node script.js [args]
node -e "code"          evaluate source text
node -p "expression"    evaluate and print the result (also --print)
node                    an interactive REPL
```

`node -p "require.resolve('left-pad')"` is a quick way to inspect a project from a terminal. [Limitations](/reference/limitations) lists where `node` differs from real Node.

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

- **install** reads `package.json` (or the named packages) and installs from the real registry (`registry.npmjs.org`, or `--registry`) into `node_modules`, saving dependencies to `package.json`. Aliases `i`, `add` and `in` work. There is **no lockfile, no lifecycle (`postinstall`) scripts, and no git, file or workspace dependencies**. A package that needs its `postinstall` needs that step done by you (for example, creating a symlink the script would have made).
- **run** executes `package.json` scripts through `sh`, with `node_modules/.bin` on `PATH`.
- **create** fetches `create-<name>` and runs its bin, like `npx create-<name>`. The bare, interactive `npm init` wizard is not supported.
- `npx <bin>` runs a binary that is already installed. It does not fetch from the registry.

Some bundlers and toolchains are swapped for WebAssembly builds so they run in a browser. See [Frameworks](/guide/frameworks) for the pins that matter.

### Showing install progress

`npm install` prints a summary line when it finishes and does not report how far along it is. If you want a progress indicator, show an indeterminate bar from `spawn` until `exit`, as Studio does; there is no percentage to read.

## Long-running work

A process lives until it exits or you kill it. When your UI removes a project, a terminal or a preview, **kill what it started**; nothing else will, and a forgotten dev server keeps its port and its memory for as long as the page is open.
