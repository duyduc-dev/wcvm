// A minimal POSIX-ish tokenizer for `sh`: words (with '...'/"..."/backslash
// handling and adjacent-part joining, e.g. a'b'"c" -> one word "abc"),
// `; && || | > >> <`, and `#` comments. No `$` expansion, globbing or `&`
// background jobs - see programs/sh/sh.ts for the scope this serves.

export class ShellSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShellSyntaxError";
  }
}

export type Operator = ";" | "&&" | "||" | "|" | ">" | ">>" | "<";
export type Token = { type: "word"; value: string } | { type: "op"; value: Operator };

const isBlank = (ch: string) => ch === " " || ch === "\t" || ch === "\n";
const isWordBoundary = (ch: string) => isBlank(ch) || ch === ";" || ch === "|" || ch === "&" || ch === ">" || ch === "<";

export const tokenize = (source: string): Token[] => {
  const tokens: Token[] = [];
  const n = source.length;
  let i = 0;

  while (i < n) {
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
      throw new ShellSyntaxError("background jobs ('&') are not supported");
    }
    if (ch === ">") {
      if (source[i + 1] === ">") {
        tokens.push({ type: "op", value: ">>" });
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
    while (i < n && !isWordBoundary(source[i])) {
      const c = source[i];
      if (c === "'") {
        const close = source.indexOf("'", i + 1);
        if (close === -1) throw new ShellSyntaxError("unterminated '");
        word += source.slice(i + 1, close);
        i = close + 1;
        continue;
      }
      if (c === '"') {
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
    tokens.push({ type: "word", value: word });
  }

  return tokens;
};
