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

export interface ILineInputOptions {
  onLine: (line: string) => void;
  /** Directory entries for Tab completion; `isDir` makes a trailing `/` get appended. */
  listDir: (dir: string) => Promise<{ name: string; isDir: boolean }[]>;
  initialCwd: string;
}

const joinPath = (cwd: string, p: string): string => {
  const parts = (p.startsWith("/") ? p : `${cwd}/${p}`).split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return "/" + out.join("/");
};

const commonPrefix = (names: string[]): string => {
  let prefix = names[0] ?? "";
  for (const n of names) while (!n.startsWith(prefix)) prefix = prefix.slice(0, -1);
  return prefix;
};

/** There's no real pty here - wcvm's `sh`/`node` REPLs are line-buffered: they read one
 * complete line at a time and never echo it back themselves (see the wcvm `sh` docs). So this
 * is a small readline of its own: it keeps the line buffer and a cursor, echoes locally,
 * sends a whole `\n`-terminated line to stdin on Enter, and supports the usual editing keys -
 * Left/Right/Home/End/Delete, Up/Down command history, Tab file/directory completion, and
 * Ctrl+A/E/U/K/W/L/C. The shell's `cwd` isn't observable from here, so it's tracked by watching
 * `cd` lines (resolved against the previous value) for completion purposes only. */
function wireLineInput(term: Terminal, options: ILineInputOptions): { dispose: () => void } {
  const { onLine, listDir } = options;
  let buffer = "";
  let cursor = 0;
  let cwd = options.initialCwd;
  const history: string[] = [];
  let historyIndex = 0; // === history.length means "the line being typed"
  let draft = "";
  let completing = false;

  /** Replace the buffer and redraw: back to the line start, rewrite, erase leftovers. */
  const setBuffer = (next: string, nextCursor = next.length): void => {
    if (cursor > 0) term.write(`\x1b[${cursor}D`);
    term.write(next + "\x1b[K");
    const back = next.length - nextCursor;
    if (back > 0) term.write(`\x1b[${back}D`);
    buffer = next;
    cursor = nextCursor;
  };

  const insert = (text: string): void => {
    setBuffer(buffer.slice(0, cursor) + text + buffer.slice(cursor), cursor + text.length);
  };

  const showHistory = (index: number): void => {
    if (index < 0 || index > history.length) return;
    if (historyIndex === history.length) draft = buffer;
    historyIndex = index;
    setBuffer(index === history.length ? draft : history[index]);
  };

  const submit = (): void => {
    term.write("\r\n");
    const line = buffer;
    if (line.trim() !== "" && history[history.length - 1] !== line) history.push(line);
    historyIndex = history.length;
    draft = "";
    const cd = /^\s*cd(?:\s+(\S+))?\s*$/.exec(line);
    if (cd) cwd = joinPath(cwd, cd[1] ?? "/");
    buffer = "";
    cursor = 0;
    onLine(line);
  };

  const complete = async (): Promise<void> => {
    const before = buffer.slice(0, cursor);
    const word = before.slice(before.search(/\S*$/));
    const slash = word.lastIndexOf("/");
    const dirPart = word.slice(0, slash + 1);
    const base = word.slice(slash + 1);
    let entries: { name: string; isDir: boolean }[];
    try {
      entries = await listDir(joinPath(cwd, dirPart === "" ? "." : dirPart));
    } catch {
      return;
    }
    const matches = entries
      .filter((e) => e.name.startsWith(base) && (base.startsWith(".") || !e.name.startsWith(".")))
      .sort((x, y) => x.name.localeCompare(y.name));
    if (matches.length === 0) return;
    // The buffer may have changed while listing; only apply if the word is still there.
    if (buffer.slice(0, cursor) !== before) return;
    if (matches.length === 1) {
      const m = matches[0];
      insert(m.name.slice(base.length) + (m.isDir ? "/" : " "));
      return;
    }
    const prefix = commonPrefix(matches.map((m) => m.name));
    if (prefix.length > base.length) {
      insert(prefix.slice(base.length));
      return;
    }
    // Ambiguous with nothing more to add: list candidates, then redraw the line below them.
    const list = matches.map((m) => (m.isDir ? m.name + "/" : m.name)).join("  ");
    term.write(`\r\n${list}\r\n`);
    const saved = buffer;
    const savedCursor = cursor;
    buffer = "";
    cursor = 0;
    setBuffer(saved, savedCursor);
  };

  const handleEscape = (seq: string): void => {
    switch (seq) {
      case "[A": return showHistory(historyIndex - 1);
      case "[B": return showHistory(historyIndex + 1);
      case "[C": case "OC":
        if (cursor < buffer.length) { cursor++; term.write("\x1b[C"); }
        return;
      case "[D": case "OD":
        if (cursor > 0) { cursor--; term.write("\x1b[D"); }
        return;
      case "[H": case "OH": case "[1~": return setBuffer(buffer, 0);
      case "[F": case "OF": case "[4~": return setBuffer(buffer, buffer.length);
      case "[3~":
        if (cursor < buffer.length) setBuffer(buffer.slice(0, cursor) + buffer.slice(cursor + 1), cursor);
        return;
    }
  };

  const subscription = term.onData((data) => {
    for (let i = 0; i < data.length; i++) {
      const ch = data[i];
      if (ch === "\x1b") {
        // CSI (`ESC [ params final`) or SS3 (`ESC O final`); anything unknown is swallowed.
        const m = /^(\[[0-9;]*[A-Za-z~]|O[A-Za-z])/.exec(data.slice(i + 1));
        if (m) {
          handleEscape(m[1]);
          i += m[1].length;
        }
      } else if (ch === "\r" || ch === "\n") {
        submit();
      } else if (ch === "\x7f" || ch === "\b") {
        if (cursor > 0) setBuffer(buffer.slice(0, cursor - 1) + buffer.slice(cursor), cursor - 1);
      } else if (ch === "\t") {
        if (!completing) {
          completing = true;
          void complete().finally(() => { completing = false; });
        }
      } else if (ch === "\x01") setBuffer(buffer, 0);
      else if (ch === "\x05") setBuffer(buffer, buffer.length);
      else if (ch === "\x15") setBuffer(buffer.slice(cursor), 0);
      else if (ch === "\x0b") setBuffer(buffer.slice(0, cursor), cursor);
      else if (ch === "\x17") {
        const start = buffer.slice(0, cursor).replace(/\S*\s*$/, "").length;
        setBuffer(buffer.slice(0, start) + buffer.slice(cursor), start);
      } else if (ch === "\x0c") {
        term.write("\x1b[2J\x1b[H");
        const saved = buffer;
        const savedCursor = cursor;
        cursor = 0; // the screen is blank, so the line is redrawn from column 0
        setBuffer(saved, savedCursor);
      } else if (ch === "\x03") {
        term.write("^C\r\n");
        buffer = "";
        cursor = 0;
        historyIndex = history.length;
        onLine("");
      } else if (ch >= " ") {
        // Take a run of printable characters at once (a paste arrives as one chunk).
        let j = i;
        while (j + 1 < data.length && data[j + 1] >= " " && data[j + 1] !== "\x7f") j++;
        insert(data.slice(i, j + 1));
        i = j;
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
  fs: { listDir: ILineInputOptions["listDir"]; cwd: string },
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
  const inputSub = wireLineInput(term, {
    initialCwd: fs.cwd,
    listDir: fs.listDir,
    onLine: (line) => {
      void writer.write(encoder.encode(line + "\n")).catch(() => {});
    },
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
