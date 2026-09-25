// A raw, pty-like terminal for an ALREADY-SPAWNED process that manages its own line editing and
// rendering via Node's real `readline` `terminal: true` mode (e.g. create-vite's own interactive
// prompts - a real, vendored `readline.emitKeypressEvents` correctly decodes arrow-key escape
// sequences into keypress events, checked directly against a real spawn before this was written).
// Unlike terminal.ts's own sh/node session - which does its OWN local line editing in the browser,
// since those REPLs are line-buffered and only read a whole line at once - this forwards every
// keystroke to the process's stdin immediately, byte for byte, with NO local echo: the process's
// own readline does that, through its own stdout, exactly like a real pty's line discipline would
// hand off to the foreground program in raw mode.

import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { IWcvm } from "wcvm";

type Process = Awaited<ReturnType<IWcvm["spawn"]>>;

/** Wires `proc` to a fresh terminal in `container`. Returns a `stop()` that detaches input (does
 *  NOT kill `proc` - the caller decides that, usually just by awaiting its own `exit`). */
export const attachInteractiveTerminal = (container: HTMLElement, proc: Process): { stop(): void } => {
  container.replaceChildren();
  const term = new Terminal({ convertEol: true, cursorBlink: true, fontSize: 13 });
  term.open(container);

  const writer = proc.stdin.getWriter();
  const encoder = new TextEncoder();
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

  const onData = term.onData((data) => {
    if (closed) return;
    void writer.write(encoder.encode(data)).catch(() => {
      // stdin already closed (process exited between the keystroke and this write)
    });
  });

  term.focus();

  return {
    stop: () => {
      closed = true;
      onData.dispose();
    },
  };
};
