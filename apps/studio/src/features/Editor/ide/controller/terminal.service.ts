import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { IProcess } from "wcvm";
import { EDITOR_FONT_FAMILY } from "./constants";

export interface TerminalHandle {
  term: Terminal;
  fit: FitAddon;
  process: IProcess;
  dispose: () => void;
}

const encoder = new TextEncoder();

// xterm's own default `cursor` color (white) is left unset by a partial theme object — fine on
// a dark background, invisible on the light one, since nothing here ever overrode it.
const terminalTheme = (isDark: boolean) => ({
  background: "#00000000",
  foreground: isDark ? "#d4d4d4" : "#1e1e1e",
  cursor: isDark ? "#d4d4d4" : "#1e1e1e",
  cursorAccent: isDark ? "#1e1e1e" : "#ffffff",
});

/** `theme` is only read at construction time otherwise — a terminal created before a later
 * `toggleTheme()` would keep its original colors forever (e.g. dark text stuck on a now-dark
 * background, unreadable). Reassigning `term.options.theme` applies live. */
export const updateTerminalTheme = (term: Terminal, isDark: boolean): void => {
  term.options.theme = terminalTheme(isDark);
};

async function pump(
  stream: ReadableStream<Uint8Array>,
  onChunk: (text: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    if (value) onChunk(decoder.decode(value, { stream: true }));
  }
}

/** There's no real pty here — wcvm's `sh`/`node` REPLs are line-buffered: they read one
 * complete line at a time and never echo it back themselves (see the wcvm `sh` docs). A raw
 * xterm keystroke stream piped straight to stdin would (a) send Enter as bare `\r`, which the
 * REPL's line reader never recognizes as end-of-line since it only splits on `\n`, so nothing
 * would ever run, and (b) show nothing at all as the user types, since nothing echoes it. This
 * does that job locally instead: buffer characters, echo them, translate Enter to a real
 * newline once a whole line is ready, and handle Backspace by erasing the buffer AND the glyph.
 * Arrow-key/CSI escape sequences are swallowed rather than inserted literally — there's no
 * command history or cursor movement to give them meaning yet. */
function wireLineInput(term: Terminal, onLine: (line: string) => void): { dispose: () => void } {
  let buffer = "";
  let escapeBytesToSwallow = 0;
  const subscription = term.onData((data) => {
    for (const ch of data) {
      if (escapeBytesToSwallow > 0) {
        escapeBytesToSwallow--;
        continue;
      }
      if (ch === "\x1b") {
        escapeBytesToSwallow = 2;
      } else if (ch === "\r" || ch === "\n") {
        term.write("\r\n");
        onLine(buffer);
        buffer = "";
      } else if (ch === "\x7f" || ch === "\b") {
        if (buffer.length > 0) {
          buffer = buffer.slice(0, -1);
          term.write("\b \b");
        }
      } else if (ch >= " " || ch === "\t") {
        buffer += ch;
        term.write(ch);
      }
    }
  });
  return { dispose: () => subscription.dispose() };
}

/** A real interactive shell (`sh` with no args is wcvm's line-buffered REPL — see the wcvm
 * `sh` docs and `wireLineInput`'s own doc comment) wired to a fresh xterm instance: stdout/
 * stderr are written to the terminal as they arrive, and completed lines (echoed and edited
 * locally by `wireLineInput`) are sent to the process's real stdin. `onExit` fires once
 * (process exit is terminal — nothing more will ever come from these streams). */
export function createShellTerminal(
  process: IProcess,
  isDark: boolean,
  onExit: () => void,
): TerminalHandle {
  const term = new Terminal({
    convertEol: true,
    fontSize: 13,
    fontFamily: EDITOR_FONT_FAMILY,
    cursorBlink: true,
    theme: terminalTheme(isDark),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);

  void pump(process.stdout, (text) => term.write(text));
  void pump(process.stderr, (text) => term.write(text));

  const writer = process.stdin.getWriter();
  const inputSub = wireLineInput(term, (line) => {
    void writer.write(encoder.encode(line + "\n")).catch(() => {});
  });

  void process.exit.then(() => onExit());

  const dispose = () => {
    inputSub.dispose();
    void writer.close().catch(() => {});
    term.dispose();
  };

  return { term, fit, process, dispose };
}

export const shellTerminalLabel = (index: number) => `sh #${index}`;
