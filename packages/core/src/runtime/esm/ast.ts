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

export interface INativeDynamicImportFunction {
  /** Position of the whole `new Function(...)`/`Function(...)` call. */
  start: number;
  end: number;
  /** Declared parameter names, in order (each was a string literal argument). */
  params: string[];
  /** Which parameter is passed as the dynamic import's specifier. */
  importParam: string;
}

/**
 * `new Function("specifier", "return import(specifier)")` - a real, common npm-ecosystem idiom
 * (seen verbatim in multiple packages, e.g. @preact/preset-vite's own transform-hook-names.mjs)
 * for forcing a REAL dynamic `import()` that survives being bundled to CommonJS, where a bundler
 * would otherwise statically rewrite a literal `import()` to `require()` - fatal for an ESM-only
 * dependency. The body is an opaque string to any AST-based rewriter (this sandbox's own
 * `dynamicImportCalls` included): `import(specifier)` inside it is invisible to a parse of the
 * ENCLOSING module, so it reaches the browser's native `import()` completely unrewritten - which
 * can't resolve a bare specifier at all (no import maps here), and fails with exactly the error
 * this was written to prevent seeing. Recognized by re-parsing the body string itself (as a
 * function body) and finding a dynamic import whose argument is one of the declared parameters.
 */
export const nativeDynamicImportFunctions = (acorn: IAcorn, program: AnyNode): INativeDynamicImportFunction[] => {
  const found: INativeDynamicImportFunction[] = [];
  walk(program, (node) => {
    if (node.type !== "NewExpression" && node.type !== "CallExpression") return;
    const callee = node.callee as AnyNode;
    if (callee.type !== "Identifier" || callee.name !== "Function") return;
    const args = node.arguments as AnyNode[];
    if (args.length === 0) return;
    const bodyArg = args[args.length - 1];
    if (bodyArg.type !== "Literal" || typeof bodyArg.value !== "string") return;
    const paramArgs = args.slice(0, -1);
    if (!paramArgs.every((a) => a.type === "Literal" && typeof a.value === "string")) return;
    const params = paramArgs.map((a) => a.value as string);

    let importParam: string | undefined;
    try {
      const wrapped = `(function(${params.join(",")}){${bodyArg.value as string}\n})`;
      const miniProgram = acorn.Parser.parse(wrapped, { sourceType: "script", ecmaVersion: "latest" });
      walk(miniProgram, (inner) => {
        if (importParam || inner.type !== "ImportExpression") return;
        const src = inner.source as AnyNode;
        if (src.type === "Identifier" && params.includes(src.name as string)) importParam = src.name as string;
      });
    } catch {
      return; // not parseable as a function body - not this pattern, leave it untouched
    }
    if (importParam) found.push({ start: node.start, end: node.end, params, importParam });
  });
  return found;
};

export interface IImportMeta {
  start: number;
  end: number;
}

/** Every `import.meta` in a module - rewritten to the module's own meta object (see rewrite.ts). */
export const importMetaProperties = (program: AnyNode): IImportMeta[] => {
  const found: IImportMeta[] = [];
  walk(program, (node) => {
    if (node.type !== "MetaProperty") return;
    const meta = node.meta as AnyNode & { name?: string };
    const property = node.property as AnyNode & { name?: string };
    if (meta.name === "import" && property.name === "meta") found.push({ start: node.start, end: node.end });
  });
  return found;
};
