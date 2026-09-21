// Node module-resolution hook for tests: lets a worker_threads fixture import
// the package's extensionless TypeScript sources ("../protocols/syscall") the
// way the bundler does, using Node's built-in type stripping. Test-only.
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
    if (error?.code === "ERR_MODULE_NOT_FOUND" && isRelative) {
      return nextResolve(`${specifier}.ts`, context);
    }
    throw error;
  }
}
