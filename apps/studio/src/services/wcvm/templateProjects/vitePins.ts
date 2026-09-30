/** `vite` itself is always pinned (create-vite@latest currently scaffolds Vite 8, which defaults
 * to Rolldown — no WebAssembly build exists for it in this sandbox, regardless of framework or
 * plugin). esbuild/Rollup's native binaries can't run in a browser either, so they're swapped for
 * their WebAssembly builds. Shared by every real-scaffold template service
 * (viteTemplateProject.ts, rectifyTemplateProject.ts). */
export const VITE_PIN = "7.3.6";

/** Each pin is a version already confirmed working against VITE_PIN in this sandbox — only
 * applied when the scaffolded project actually depends on that plugin. */
export const KNOWN_PLUGIN_PINS: Record<string, string> = {
  "@vitejs/plugin-react": "^5.0.0",
  "@vitejs/plugin-vue": "^6.0.0",
  // create-vite's svelte-ts template currently pulls in vite-plugin-svelte@^7.3.0, which needs
  // vite@8+ (this sandbox has no WASM Rolldown build - see VITE_PIN's own comment). ^6.2.4 is
  // the last major still compatible with vite@7 (peerDependencies: "^6.3.0 || ^7.0.0" - confirmed
  // via `npm view @sveltejs/vite-plugin-svelte@6.2.4 peerDependencies` directly, not assumed).
  "@sveltejs/vite-plugin-svelte": "^6.2.4",
};

export const WASM_OVERRIDES: Record<string, string> = {
  esbuild: "npm:esbuild-wasm@0.28.2",
  rollup: "npm:@rollup/wasm-node@4.63.4",
};

/** Mutates a parsed package.json in place: pins `vite`, pins any known plugin it already
 * depends on, and merges in the WASM overrides. */
export function pinVitePackage(pkg: {
  devDependencies?: Record<string, string>;
  overrides?: Record<string, string>;
}): void {
  pkg.devDependencies ??= {};
  pkg.devDependencies.vite = VITE_PIN;
  for (const [name, pin] of Object.entries(KNOWN_PLUGIN_PINS)) {
    if (pkg.devDependencies[name]) pkg.devDependencies[name] = pin;
  }
  pkg.overrides = { ...pkg.overrides, ...WASM_OVERRIDES };
}
