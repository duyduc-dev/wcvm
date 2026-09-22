// node's interactive REPL: real Node's own repl.js needs raw-mode TTY, ANSI cursor control and
// tab-completion machinery our tty_wrap deliberately stubs out, so this is a small loop of our
// own instead, built on the already-vendored, TTY-independent readline. Variable persistence
// across lines comes from `evaluate` (indirect eval against the process's own real global object
// in production - see runtime.ts's runRepl) rather than from vendoring Node's repl module.

export interface IReplOptions {
  /** Needs `.stdin`, `.stdout.write()`, `.exit()`, `.exitCode` - the real `process` is Record<string, any>. */
  process: any;
  /** Pulls "readline" and "internal/util/inspect" off the runtime's builtin loader. */
  requireBuiltin: (id: string) => any;
  /** Runs one line of source; the returned value (or thrown error) is printed. Injected so tests
   *  never touch a real global object - see runtime.ts's runRepl for the production wiring. */
  evaluate: (code: string) => unknown;
  prompt?: string;
}

/** Starts the REPL loop; returns once readline closes (EOF or `.exit`). */
const startRepl = (options: IReplOptions): void => {
  const { process, requireBuiltin, evaluate, prompt = "> " } = options;
  const { inspect } = requireBuiltin("internal/util/inspect");
  const readline = requireBuiltin("readline");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false, prompt });

  rl.on("line", (line: string) => {
    const trimmed = line.trim();
    if (trimmed === ".exit") {
      // Deferred: throwing ProcessExit synchronously from inside readline's own "line"
      // emission (itself called from deep inside the vendored stream internals) risks that
      // throw being intercepted as a stream-internal error instead of reaching the runtime's
      // own uncaught-exception handling. A nextTick callback runs with a clean call stack.
      process.nextTick(() => process.exit());
      return;
    }
    if (trimmed !== "") {
      try {
        const value = evaluate(line);
        process.stdout.write(`${inspect(value)}\n`);
      } catch (error) {
        process.stdout.write(`Uncaught ${inspect(error)}\n`);
      }
    }
    rl.prompt();
  });

  rl.on("close", () => process.nextTick(() => process.exit(process.exitCode ?? 0)));

  rl.prompt();
};

export { startRepl };
