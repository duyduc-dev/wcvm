// Wires an xterm.js terminal to a real interactive wcvm session (`sh` or `node`, both real
// REPLs now - see PLAN.md's Phase 5 / node.ts's runRepl). There's no real pty here, so this
// does its own minimal local line-editing (echo, backspace, Enter -> "\n", Ctrl-D -> close
// stdin) rather than forwarding raw keystrokes - a real shell's line editing normally comes
// from the pty's line discipline, not the shell program itself, and our sh/node REPLs are
// line-buffered (they only act once a "\n" arrives), not raw-mode.

import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { IWcvm } from "wcvm";

const ENTER = "\r";
const BACKSPACE = "\x7f";
const CTRL_D = "\x04";
const CTRL_C = "\x03";

/** Spawns `program` interactively and connects it to a fresh terminal in `container`. Returns a
 *  `stop()` that kills the process; call it before attaching a new session to the same container. */
export const attachTerminal = async (wc: IWcvm, container: HTMLElement, program: string) => {
  container.replaceChildren();
  const term = new Terminal({ convertEol: true, cursorBlink: true, fontSize: 13 });
  term.open(container);
  term.writeln(`[wcvm] starting ${program}...`);

  // xterm.js already renders ANSI color codes natively - what's missing is the guest process
  // ever emitting any. Real Node (util.inspect's REPL colors, console.log) and most CLI color
  // libraries (chalk, picocolors, ...) all decide that from FORCE_COLOR/isTTY - and since
  // wcvm's own `tty_wrap`.isatty() is always false (no real TTY here), they'd otherwise stay
  // colorless even though this terminal can display color just fine. FORCE_COLOR="3" (real
  // Node's own internal/tty.js getColorDepth: 24-bit truecolor) tells them to color anyway,
  // exactly like a CI system with no real TTY but a color-capable log viewer would.
  const proc = await wc.spawn(program, [], { env: { FORCE_COLOR: "3" } });
  const writer = proc.stdin.getWriter();
  const encoder = new TextEncoder();
  let line = "";
  let closed = false;

  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      term.write(value);
    }
  };
  void pump(proc.stdout);
  void pump(proc.stderr);

  proc.exit.then((result) => {
    closed = true;
    term.writeln(`\r\n[wcvm] ${program} exited with code ${result.exitCode}`);
  });

  const send = async (text: string) => {
    if (closed) return;
    try {
      await writer.write(encoder.encode(text));
    } catch {
      // stdin already closed (process exited between the keystroke and this write)
    }
  };

  term.onData((data) => {
    if (closed) return;
    for (const char of data) {
      if (char === ENTER) {
        term.write("\r\n");
        void send(`${line}\n`);
        line = "";
      } else if (char === BACKSPACE) {
        if (line.length === 0) continue;
        line = line.slice(0, -1);
        term.write("\b \b");
      } else if (char === CTRL_D) {
        if (line.length === 0) {
          closed = true;
          void writer.close().catch(() => {});
        }
      } else if (char === CTRL_C) {
        term.write("^C\r\n");
        line = "";
      } else {
        line += char;
        term.write(char);
      }
    }
  });

  term.focus();

  return {
    stop: () => {
      closed = true;
      proc.kill();
    },
    /** Writes text straight into this terminal, interleaved with whatever the session itself is
     *  doing - for output from somewhere else entirely (the React example's own npm/vite
     *  processes), not from this session's own process. */
    write: (text: string) => term.write(text),
  };
};
