/** A vendored Node builtin, wrapped exactly like Node's own BuiltinModule loader wraps it. */
export type BuiltinFactory = (
  exports: Record<string, unknown>,
  require: (id: string) => any,
  module: { exports: any; id: string },
  process: any,
  internalBinding: (name: string) => any,
  primordials: Record<string | symbol, any>,
) => void;

/** `internal/per_context/*`: run once per realm to populate shared objects. */
export type PerContextFactory = (
  exports: Record<string, unknown>,
  primordials: Record<string | symbol, any>,
  privateSymbols: Record<string, symbol>,
  perIsolateSymbols: Record<string, symbol>,
) => void;
