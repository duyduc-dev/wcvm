// A minimal POSIX-ish tokenizer for `sh`: words (with '...'/"..."/backslash
// handling and adjacent-part joining, e.g. a'b'"c" -> one word "abc"),
// `; && || | > >> <` (with an optional leading fd number: `2>file`), fd duplication (`2>&1`,
// `>&2`), `&>`/`&>>` (stdout+stderr to a file), and `#` comments. No `$` expansion, globbing or `&`
// background jobs - see programs/sh/sh.ts for the scope this serves.

export class ShellSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShellSyntaxError";
  }
}

export type Operator = ";" | "&&" | "||" | "|" | ">" | ">>" | "<" | ">&" | "&>" | "&>>";
/** `fd` is the number written right before a redirect operator (`2>file`); absent = the default. */
export type Token = { type: "word"; value: string } | { type: "op"; value: Operator; fd?: number };

const isBlank = (ch: string) => ch === " " || ch === "\t" || ch === "\n";
const isWordBoundary = (ch: string) => isBlank(ch) || ch === ";" || ch === "|" || ch === "&" || ch === ">" || ch === "<";

export const tokenize = (source: string): Token[] => {
  const tokens: Token[] = [];
  const n = source.length;
  let i = 0;
  let pendingFd: { index: number; fd: number } | undefined;

  while (i < n) {
    if (pendingFd && tokens.length > pendingFd.index) {
      (tokens[pendingFd.index] as { fd?: number }).fd = pendingFd.fd;
      pendingFd = undefined;
    }
    const ch = source[i];
    if (isBlank(ch)) {
      i++;
      continue;
    }
    if (ch === "#") {
      while (i < n && source[i] !== "\n") i++;
      continue;
    }
    if (ch === ";") {
      tokens.push({ type: "op", value: ";" });
      i++;
      continue;
    }
    if (ch === "|") {
      if (source[i + 1] === "|") {
        tokens.push({ type: "op", value: "||" });
        i += 2;
      } else {
        tokens.push({ type: "op", value: "|" });
        i++;
      }
      continue;
    }
    if (ch === "&") {
      if (source[i + 1] === "&") {
        tokens.push({ type: "op", value: "&&" });
        i += 2;
        continue;
      }
      if (source[i + 1] === ">") {
        const append = source[i + 2] === ">";
        tokens.push({ type: "op", value: append ? "&>>" : "&>" });
        i += append ? 3 : 2;
        continue;
      }
      throw new ShellSyntaxError("background jobs ('&') are not supported");
    }
    if (ch === ">") {
      if (source[i + 1] === ">") {
        tokens.push({ type: "op", value: ">>" });
        i += 2;
      } else if (source[i + 1] === "&" && source[i + 2] !== "&") {
        tokens.push({ type: "op", value: ">&" });
        i += 2;
      } else {
        tokens.push({ type: "op", value: ">" });
        i++;
      }
      continue;
    }
    if (ch === "<") {
      tokens.push({ type: "op", value: "<" });
      i++;
      continue;
    }

    let word = "";
    let quoted = false;
    while (i < n && !isWordBoundary(source[i])) {
      const c = source[i];
      if (c === "'") {
        quoted = true;
        const close = source.indexOf("'", i + 1);
        if (close === -1) throw new ShellSyntaxError("unterminated '");
        word += source.slice(i + 1, close);
        i = close + 1;
        continue;
      }
      if (c === '"') {
        quoted = true;
        i++;
        while (i < n && source[i] !== '"') {
          if (source[i] === "\\" && (source[i + 1] === '"' || source[i + 1] === "\\")) {
            word += source[i + 1];
            i += 2;
          } else {
            word += source[i];
            i++;
          }
        }
        if (i >= n) throw new ShellSyntaxError('unterminated "');
        i++;
        continue;
      }
      if (c === "\\" && i + 1 < n) {
        word += source[i + 1];
        i += 2;
        continue;
      }
      word += c;
      i++;
    }
    // A bare number glued to a redirect operator is a file descriptor (`2>file`, `2>&1`), not an
    // argument.
    if (!quoted && /^\d+$/.test(word) && (source[i] === ">" || source[i] === "<")) {
      const fd = Number(word);
      const before = tokens.length;
      // Tokenize the operator itself on the next loop pass, then tag it.
      pendingFd = { index: before, fd };
      continue;
    }
    tokens.push({ type: "word", value: word });
  }

  if (pendingFd && tokens.length > pendingFd.index) (tokens[pendingFd.index] as { fd?: number }).fd = pendingFd.fd;
  return tokens;
};
