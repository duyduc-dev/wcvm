import { ShellSyntaxError, Token, tokenize } from "./tokenize";

export interface IRedirect {
  type: ">" | ">>" | "<";
  target: string;
}
export interface ISimpleCommand {
  /** words[0] is the command name. */
  words: string[];
  redirects: IRedirect[];
}
export interface IPipeline {
  commands: ISimpleCommand[];
}
export interface IScript {
  /** Pipelines joined by ; && ||; `op` is the operator before this pipeline (absent for the first). */
  parts: Array<{ op?: ";" | "&&" | "||"; pipeline: IPipeline }>;
}

const isRedirectOp = (value: string): value is IRedirect["type"] => value === ">" || value === ">>" || value === "<";

/** Parses one `sh` script: `pipeline (( ; | && | || ) pipeline)*`, trailing `;` allowed. */
export const parse = (source: string): IScript => {
  const tokens = tokenize(source);
  let pos = 0;
  const peek = (): Token | undefined => tokens[pos];

  const parseSimpleCommand = (): ISimpleCommand => {
    const words: string[] = [];
    const redirects: IRedirect[] = [];
    for (;;) {
      const tok = peek();
      if (!tok) break;
      if (tok.type === "word") {
        words.push(tok.value);
        pos++;
        continue;
      }
      if (isRedirectOp(tok.value)) {
        pos++;
        const target = peek();
        if (!target || target.type !== "word") {
          throw new ShellSyntaxError(`expected a filename after '${tok.value}'`);
        }
        redirects.push({ type: tok.value, target: target.value });
        pos++;
        continue;
      }
      break; // ; && || | end the command
    }
    if (words.length === 0) throw new ShellSyntaxError("expected a command");
    return { words, redirects };
  };

  const parsePipeline = (): IPipeline => {
    const commands = [parseSimpleCommand()];
    while (peek()?.type === "op" && (peek() as { value: string }).value === "|") {
      pos++;
      commands.push(parseSimpleCommand());
    }
    return { commands };
  };

  const parts: IScript["parts"] = [{ pipeline: parsePipeline() }];
  for (;;) {
    const tok = peek();
    if (!tok || tok.type !== "op" || (tok.value !== ";" && tok.value !== "&&" && tok.value !== "||")) break;
    pos++;
    if (tok.value === ";" && !peek()) break; // a trailing `;` is fine; && / || still need a command after
    parts.push({ op: tok.value, pipeline: parsePipeline() });
  }

  const trailing = peek();
  if (trailing) throw new ShellSyntaxError(`unexpected token '${trailing.value}'`);
  return { parts };
};
