// Turns an IStdinHost's arbitrary chunk boundaries into whole lines for the sh REPL.
// Yields a final, unterminated trailing line at EOF too (matching real shell behavior:
// input with no trailing newline before EOF still runs as one last command).

import type { IStdinHost } from "../../runtime/runtime";

export interface ILineReader {
  /** Resolves to the next line (without its newline), or null once nothing is left. */
  nextLine(): Promise<string | null>;
}

const createLineReader = (stdin: IStdinHost): ILineReader => {
  const decoder = new TextDecoder();
  const queue: Array<string | null> = [];
  let buffer = "";
  let eof = false;
  let waiting: ((value: string | null) => void) | null = null;

  const push = (line: string | null) => {
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(line);
    } else {
      queue.push(line);
    }
  };

  stdin.onData((chunk) => {
    if (chunk === null) {
      eof = true;
      if (buffer.length > 0) {
        const last = buffer;
        buffer = "";
        push(last);
      }
      push(null);
      return;
    }
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) push(line);
  });

  return {
    nextLine: () =>
      new Promise((resolve) => {
        if (queue.length > 0) {
          resolve(queue.shift()!);
          return;
        }
        if (eof) {
          resolve(null);
          return;
        }
        waiting = resolve;
      }),
  };
};

export { createLineReader };
