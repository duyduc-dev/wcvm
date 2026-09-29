import { getWcvmInstance } from "@/lib/wcvm";
import { KNOWN_PLUGIN_PINS, VITE_PIN, WASM_OVERRIDES } from "./vitePins";

// Sibling to DEFAULT_PROJECTS_DIR's own /home/user/projects, not inside it - so it's never
// mistaken for a project by anything that lists /home/user/projects/*. Also lands at the same
// path depth (3) as "projects" itself, so each cached template (depth 4, one segment down) gets
// the exact same OPFS lazy-restore treatment a real project does (see lib/wcvm/index.ts's
// lazyDepth: 4) - a cached template nobody has touched yet costs nothing at boot either.
const CACHE_ROOT = "/home/user/.template-cache";

// Bump whenever what a "kind" SHOULD produce changes in a way `cacheKeyFor`'s own pin-signature
// hash doesn't already capture: either the SHAPE of what gets cached (e.g. a future version needs
// to store something alongside the project files), or - found for real, not hypothetically, when
// a template's own hardcoded recipe file content changed (tanstackRouterTemplateProject.ts's
// MAIN_TSX gained a runtime basepath fix) while its PIN configuration stayed exactly the same: a
// project cached from BEFORE that fix still matched the unchanged cache key and kept getting
// cloned as-is, even into a brand-new project, completely masking the fix with no error anywhere -
// only noticed because a real user hit the exact bug the fix was for, in a project that turned out
// to be a stale cache clone. A change to the pin VALUES below doesn't need a bump either way (see
// cacheKeyFor's own comment) - only a change to what's HARDCODED in a specific template's own
// recipe file(s) does.
const CACHE_SCHEMA_VERSION = 2;

/** A tiny non-cryptographic string hash (FNV-1a) - this keys a local cache, not a security
 *  boundary, so deterministic + low collision risk for a handful of short config strings is all
 *  it needs to be. */
function hashString(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** Keys a cached template by its own identity plus the EXACT pin configuration that produced it
 *  (vitePins.ts's VITE_PIN/KNOWN_PLUGIN_PINS/WASM_OVERRIDES) - if those pins ever change in a
 *  future update, every existing cache entry's own key changes too, so a stale one (built under
 *  the old pins) is simply never looked up again. Not overwritten, not migrated - just abandoned
 *  (acceptable: OPFS quota is large for a handful of small cache entries, and "Clear All" sweeps
 *  /home, and so this too, like everything else). */
function cacheKeyFor(kind: string): string {
  const pinSignature = JSON.stringify({ VITE_PIN, KNOWN_PLUGIN_PINS, WASM_OVERRIDES });
  return `v${CACHE_SCHEMA_VERSION}-${kind}-${hashString(pinSignature)}`;
}

function cachePathFor(kind: string): string {
  return `${CACHE_ROOT}/${cacheKeyFor(kind)}`;
}

/** create-vite bakes the scaffolding project's own name into exactly two places - package.json's
 *  "name" and index.html's <title> (confirmed directly against a real scaffold: nowhere else in
 *  a fresh react-ts project's own files mentions the project name at all). A cache clone rewrites
 *  both to the NEW project's own name; everything else in a scaffolded project is name-independent
 *  and needs no fix-up. */
async function renameClonedProject(projectPath: string): Promise<void> {
  const wc = getWcvmInstance();
  const projectName = projectPath.split("/").at(-1)!;

  const pkgPath = `${projectPath}/package.json`;
  if (await wc.fs.exists(pkgPath)) {
    const pkg = JSON.parse(new TextDecoder().decode(await wc.fs.readFile(pkgPath)));
    pkg.name = projectName;
    await wc.fs.writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  }

  const indexPath = `${projectPath}/index.html`;
  if (await wc.fs.exists(indexPath)) {
    const html = new TextDecoder().decode(await wc.fs.readFile(indexPath));
    await wc.fs.writeFile(indexPath, html.replace(/<title>[^<]*<\/title>/, `<title>${projectName}</title>`));
  }
}

/**
 * If `kind` (a template identity - "react-ts", "vue-ts", "vanilla", "rectify") has a cached,
 * already-installed project, clones it straight into `projectPath` (wc.fs.cp() - entirely inside
 * the Vfs, no network, no npm resolution/extraction) and renames it, instead of the caller
 * running a real npm create + npm install. Returns false (a clean no-op - `projectPath` is left
 * untouched) when there's no cache yet, OR when a clone was attempted but failed (a corrupted
 * cache entry, say): the caller should fall back to its own real scaffold+install either way.
 */
export async function tryCloneFromCache(kind: string, projectPath: string): Promise<boolean> {
  const wc = getWcvmInstance();
  const cachePath = cachePathFor(kind);
  if (!(await wc.fs.exists(cachePath))) return false;

  try {
    await wc.fs.cp(cachePath, projectPath);
    await renameClonedProject(projectPath);
    await wc.fs.sync();
    return true;
  } catch (error) {
    console.error(`wcvm studio: failed to clone the "${kind}" template cache, falling back to a real install:`, error);
    // A partial clone would otherwise look like "a project already exists here" to the caller's
    // own real scaffold attempt at the exact same path right after this.
    if (await wc.fs.exists(projectPath)) await wc.fs.rm(projectPath, { recursive: true }).catch(() => {});
    return false;
  }
}

/**
 * Populates the cache for `kind` from an already fully-installed `projectPath`, for next time -
 * best-effort (a real project creation must never fail because of this). Two concurrent creations
 * of the same never-yet-cached kind racing this is fine: whichever loses just finds the cache
 * already there and leaves it alone.
 *
 * Deliberately fire-and-forget from the CALLER's side (see viteTemplateProject.ts/
 * rectifyTemplateProject.ts - `void populateCache(...)`, called AFTER their own final
 * wc.fs.sync(), never awaited): folding the cache copy into the SAME sync() a real creation
 * already has to do doubles the file count that sync() has to wait for, and the write-behind
 * mirror's own throughput does not scale linearly with load - confirmed directly, doubling the
 * file count (~683 -> ~1366) roughly QUADRUPLED that one sync() call's own time (~1.5s -> ~6s) in
 * a real measurement, not just doubled it. A first-ever creation of a given template must stay
 * exactly as fast as it already is; the cache existing for NEXT time is a pure bonus, never worth
 * slowing THIS time down for. The real risk this accepts: a reload landing before this specific
 * background sync finishes could leave a half-written cache entry - harmless, since
 * tryCloneFromCache's own error handling already treats a broken clone as a plain cache miss and
 * falls back to a real install, exactly as if this had never run at all.
 */
export async function populateCache(kind: string, projectPath: string): Promise<void> {
  const wc = getWcvmInstance();
  try {
    if (!(await wc.fs.exists(CACHE_ROOT))) await wc.fs.mkdir(CACHE_ROOT, { recursive: true });
    const cachePath = cachePathFor(kind);
    if (await wc.fs.exists(cachePath)) return;
    await wc.fs.cp(projectPath, cachePath);
    await wc.fs.sync();
  } catch (error) {
    console.error(`wcvm studio: failed to populate the "${kind}" template cache - future creations of it will just run a real install again:`, error);
  }
}
