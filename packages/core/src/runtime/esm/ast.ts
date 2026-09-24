// Thin layer over Node's real vendored acorn: parses ESM source into an
// ESTree AST and extracts what runtime/esm/rewrite.ts needs - top-level
// static import/export specifiers, and dynamic import() call sites anywhere
// in the tree. No AST types beyond `AnyNode`: acorn's own types aren't
// exported from the UMD build we vendor, and this only ever reads a handful
// of well-known ESTree shapes.

export type AnyNode = Record<string, unknown> & { type: string; start: number; end: number };

export interface IAcorn {
  Parser: {
    parse(
      input: string,
      options: { sourceType: "module" | "script"; ecmaVersion: "latest"; allowReturnOutsideFunction?: boolean; allowHashBang?: boolean },
    ): AnyNode;
  };
}

export class EsmSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EsmSyntaxError";
  }
}

export const parseModule = (acorn: IAcorn, source: string, filename: string): AnyNode => {
  try {
    return acorn.Parser.parse(source, { sourceType: "module", ecmaVersion: "latest" });
  } catch (error) {
    throw new EsmSyntaxError(`${filename}: ${error instanceof Error ? error.message : String(error)}`);
  }
};

/** A CommonJS module's (or `node -e`'s) source: a script, where a top-level `return` is legal
 *  (the CJS wrapper makes it a function body) and a leading `#!` line is allowed. */
export const parseScript = (acorn: IAcorn, source: string, filename: string): AnyNode => {
  try {
    return acorn.Parser.parse(source, { sourceType: "script", ecmaVersion: "latest", allowReturnOutsideFunction: true, allowHashBang: true });
  } catch (error) {
    throw new EsmSyntaxError(`${filename}: ${error instanceof Error ? error.message : String(error)}`);
  }
};

/** Visits every node in the tree exactly once, depth-first; order is unspecified beyond that. */
export const walk = (node: unknown, visit: (node: AnyNode) => void): void => {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  const record = node as AnyNode;
  if (typeof record.type === "string") visit(record);
  for (const key of Object.keys(record)) {
    if (key === "type" || key === "start" || key === "end" || key === "loc" || key === "range") continue;
    const value = (record as Record<string, unknown>)[key];
    if (value && typeof value === "object") walk(value, visit);
  }
};

export interface IStaticSpecifier {
  /**
   * Position to replace with the resolved URL: the specifier string literal
   * itself, quotes included, extended through a trailing `with {...}` /
   * `assert {...}` clause when present. That clause describes the ORIGINAL
   * resource (e.g. `with { type: "json" }`); every non-esm format is already
   * unwrapped into a synthetic plain-JS blob by loader.ts, so the clause no
   * longer applies to what's actually being imported and must not survive
   * the rewrite - the browser would otherwise try to parse the blob's JS
   * source as JSON (or whatever the original attribute said).
   */
  start: number;
  end: number;
  value: string;
}

/** `node.end` includes a written trailing semicolon (unlike ASI); back up over it so callers can splice in a replacement without duplicating or losing it. */
const beforeTrailingSemicolon = (source: string, end: number): number => (source[end - 1] === ";" ? end - 1 : end);

/** Top-level `import`/`export ... from`/`export * from` specifiers only - exactly what must be resolved before evaluation can begin. */
export const staticImportSpecifiers = (program: AnyNode, source: string): IStaticSpecifier[] => {
  const body = program.body as AnyNode[];
  const specifiers: IStaticSpecifier[] = [];
  for (const node of body) {
    if (node.type !== "ImportDeclaration" && node.type !== "ExportNamedDeclaration" && node.type !== "ExportAllDeclaration") continue;
    const specifierSource = node.source as AnyNode | null | undefined;
    if (!specifierSource) continue; // a plain `export { x }` / `export const x = ...` has no specifier
    const attributes = node.attributes as AnyNode[] | undefined;
    const end = attributes && attributes.length > 0 ? beforeTrailingSemicolon(source, node.end) : specifierSource.end;
    specifiers.push({ start: specifierSource.start, end, value: specifierSource.value as string });
  }
  return specifiers;
};

export interface IDynamicImportCall {
  /** Position of the whole `import(...)` expression. */
  start: number;
  end: number;
  /** Position of the argument expression's own source, unevaluated - copied verbatim into the rewritten call. */
  argStart: number;
  argEnd: number;
}

/** Every `import(...)` call anywhere in the tree, static or dynamic argument alike - resolved lazily at call time, so it never needs a blob URL up front. */
export const dynamicImportCalls = (program: AnyNode): IDynamicImportCall[] => {
  const calls: IDynamicImportCall[] = [];
  walk(program, (node) => {
    if (node.type !== "ImportExpression") return;
    const source = node.source as AnyNode;
    calls.push({ start: node.start, end: node.end, argStart: source.start, argEnd: source.end });
  });
  return calls;
};
