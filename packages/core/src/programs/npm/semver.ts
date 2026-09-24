// npm's own semver semantics (the `semver` package, strict mode, includePrerelease off) - just the
// part an installer needs: parse a version, parse a range, `satisfies`, and pick the best version.
// Hand-written rather than vendored, like the rest of this repo's non-Node-lib code; checked
// against the real `semver` package's own answers (semver.test.ts's oracle table).
//
// A range desugars into sets of plain comparators (`^1.2.3` -> `>=1.2.3 <2.0.0-0`), ORed together
// (`||`); a version satisfies a set if it passes every comparator in it. The one non-obvious rule:
// a PRERELEASE version (`2.0.0-beta.1`) only satisfies a set that itself names a prerelease of the
// same major.minor.patch - so `^1.0.0` never picks up `1.5.0-rc.1`, but `>=1.5.0-rc.0` does.

export interface ISemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: Array<string | number>;
}

const NUMERIC = /^(0|[1-9]\d*)$/;
const IDENTIFIER = /^[0-9A-Za-z-]+$/;
const VERSION = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

const parsePrerelease = (text: string | undefined): Array<string | number> | undefined => {
  if (text === undefined) return [];
  const parts = text.split(".");
  if (parts.some((part) => !IDENTIFIER.test(part) || (/^\d+$/.test(part) && !NUMERIC.test(part)))) return undefined;
  return parts.map((part) => (NUMERIC.test(part) ? Number(part) : part));
};

/** A strict version (`1.2.3`, `v1.2.3-beta.1+build`, `=1.2.3`), or undefined if it isn't one. */
export const parseVersion = (text: string): ISemVer | undefined => {
  const match = VERSION.exec(text.trim().replace(/^=+\s*/, ""));
  if (!match) return undefined;
  const prerelease = parsePrerelease(match[4]);
  if (!prerelease) return undefined;
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (![major, minor, patch].every(Number.isSafeInteger)) return undefined;
  return { major, minor, patch, prerelease };
};

const compareIdentifiers = (a: string | number, b: string | number): number => {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "number") return -1; // numeric identifiers sort before alphanumeric ones
  if (typeof b === "number") return 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
};

export const compareVersions = (a: ISemVer, b: ISemVer): number => {
  const main = a.major - b.major || a.minor - b.minor || a.patch - b.patch;
  if (main) return main;
  // A prerelease sorts before its release; otherwise identifier by identifier, shorter first.
  if (!a.prerelease.length || !b.prerelease.length) return b.prerelease.length - a.prerelease.length;
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    if (i >= a.prerelease.length) return -1;
    if (i >= b.prerelease.length) return 1;
    const diff = compareIdentifiers(a.prerelease[i], b.prerelease[i]);
    if (diff) return diff;
  }
  return 0;
};

export const formatVersion = (v: ISemVer): string => {
  const core = `${v.major}.${v.minor}.${v.patch}`;
  return v.prerelease.length ? `${core}-${v.prerelease.join(".")}` : core;
};

type Operator = "<" | "<=" | ">" | ">=" | "=";

interface IComparator {
  operator: Operator;
  version: ISemVer;
}

const testComparator = ({ operator, version }: IComparator, v: ISemVer): boolean => {
  const c = compareVersions(v, version);
  switch (operator) {
    case "<": return c < 0;
    case "<=": return c <= 0;
    case ">": return c > 0;
    case ">=": return c >= 0;
    case "=": return c === 0;
  }
};

/** A partial version: each of major/minor/patch may be missing or an x (`1`, `1.x`, `1.2.*`). */
interface IPartial {
  major?: number;
  minor?: number;
  patch?: number;
  prerelease: Array<string | number>;
}

const XR = String.raw`(?:0|[1-9]\d*|[xX*])`;
const PARTIAL = new RegExp(String.raw`^v?=?(${XR})(?:\.(${XR})(?:\.(${XR})(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?)?)?$`);

const parsePartial = (text: string): IPartial | undefined => {
  const match = PARTIAL.exec(text);
  if (!match) return undefined;
  const num = (part: string | undefined) => (part === undefined || /^[xX*]$/.test(part) ? undefined : Number(part));
  const prerelease = parsePrerelease(match[4]);
  if (!prerelease) return undefined;
  const major = num(match[1]);
  const minor = major === undefined ? undefined : num(match[2]);
  const patch = minor === undefined ? undefined : num(match[3]);
  return { major, minor, patch, prerelease };
};

const v = (major: number, minor: number, patch: number, prerelease: Array<string | number> = []): ISemVer => ({ major, minor, patch, prerelease });
/** The `-0` lower bound of a version's prereleases: `<2.0.0-0` excludes 2.0.0's prereleases too. */
const lowest = (major: number, minor: number, patch: number) => v(major, minor, patch, [0]);
const NOTHING: IComparator[] = [{ operator: "<", version: lowest(0, 0, 0) }];
const ANYTHING: IComparator[] = [{ operator: ">=", version: v(0, 0, 0) }];

/** `1.2.3` -> `=1.2.3`, `1.2` -> `>=1.2.0 <1.3.0-0`, `1` -> `>=1.0.0 <2.0.0-0`, `*` -> anything. */
const xRange = (p: IPartial): IComparator[] => {
  if (p.major === undefined) return ANYTHING;
  if (p.minor === undefined) return [{ operator: ">=", version: v(p.major, 0, 0) }, { operator: "<", version: lowest(p.major + 1, 0, 0) }];
  if (p.patch === undefined) return [{ operator: ">=", version: v(p.major, p.minor, 0) }, { operator: "<", version: lowest(p.major, p.minor + 1, 0) }];
  return [{ operator: "=", version: v(p.major, p.minor, p.patch, p.prerelease) }];
};

const tilde = (p: IPartial): IComparator[] => {
  if (p.major === undefined) return ANYTHING;
  if (p.minor === undefined) return xRange(p);
  const from = v(p.major, p.minor, p.patch ?? 0, p.patch === undefined ? [] : p.prerelease);
  return [{ operator: ">=", version: from }, { operator: "<", version: lowest(p.major, p.minor + 1, 0) }];
};

/** Everything up to the next change in the left-most non-zero part. */
const caret = (p: IPartial): IComparator[] => {
  if (p.major === undefined) return ANYTHING;
  const minor = p.minor ?? 0;
  const patch = p.patch ?? 0;
  const from = v(p.major, minor, patch, p.patch === undefined ? [] : p.prerelease);
  let to: ISemVer;
  if (p.major > 0 || p.minor === undefined) to = lowest(p.major + 1, 0, 0);
  else if (minor > 0 || p.patch === undefined) to = lowest(0, minor + 1, 0);
  else to = lowest(0, 0, patch + 1);
  return [{ operator: ">=", version: from }, { operator: "<", version: to }];
};

/** `<`/`<=`/`>`/`>=`/`=` against a partial: `>1` -> `>=2.0.0`, `<=1.2` -> `<1.3.0-0`, ... */
const primitive = (operator: Operator, p: IPartial): IComparator[] => {
  if (operator === "=") return xRange(p);
  if (p.major === undefined) return operator === "<" || operator === ">" ? NOTHING : ANYTHING;
  if (p.minor !== undefined && p.patch !== undefined) return [{ operator, version: v(p.major, p.minor, p.patch, p.prerelease) }];
  const minorX = p.minor === undefined;
  const minor = p.minor ?? 0;
  switch (operator) {
    case ">": return [{ operator: ">=", version: minorX ? v(p.major + 1, 0, 0) : v(p.major, minor + 1, 0) }];
    case ">=": return [{ operator: ">=", version: v(p.major, minor, 0) }];
    case "<": return [{ operator: "<", version: lowest(p.major, minor, 0) }];
    case "<=": return [{ operator: "<", version: minorX ? lowest(p.major + 1, 0, 0) : lowest(p.major, minor + 1, 0) }];
  }
};

/** `1.2.3 - 2.3` -> `>=1.2.3 <2.4.0-0`: inclusive on both ends, an x-ish end means "all of it". */
const hyphen = (from: IPartial, to: IPartial): IComparator[] => {
  const lower = from.major === undefined ? [] : [{ operator: ">=" as const, version: v(from.major, from.minor ?? 0, from.patch ?? 0, from.patch === undefined ? [] : from.prerelease) }];
  let upper: IComparator[];
  if (to.major === undefined) upper = [];
  else if (to.minor === undefined) upper = [{ operator: "<", version: lowest(to.major + 1, 0, 0) }];
  else if (to.patch === undefined) upper = [{ operator: "<", version: lowest(to.major, to.minor + 1, 0) }];
  else upper = [{ operator: "<=", version: v(to.major, to.minor, to.patch, to.prerelease) }];
  const set = [...lower, ...upper];
  return set.length ? set : ANYTHING;
};

const HYPHEN = /^(\S+)\s+-\s+(\S+)$/;
const SIMPLE = /^(~>?|\^|<=|>=|<|>|=)?(.*)$/;

const parseComparatorSet = (text: string): IComparator[] | undefined => {
  const trimmed = text.trim();
  const hyphenMatch = HYPHEN.exec(trimmed);
  if (hyphenMatch) {
    const from = parsePartial(hyphenMatch[1]);
    const to = parsePartial(hyphenMatch[2]);
    return from && to ? hyphen(from, to) : undefined;
  }
  // `>= 1.2.3`, `~ 1.2`: an operator may be separated from its version by whitespace.
  const tokens = trimmed.replace(/(~>?|\^|<=|>=|<|>|=)\s+/g, "$1").split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return ANYTHING;
  const set: IComparator[] = [];
  for (const token of tokens) {
    const [, operator = "", rest] = SIMPLE.exec(token)!;
    const partial = parsePartial(rest);
    if (!partial) return undefined;
    if (operator.startsWith("~")) set.push(...tilde(partial));
    else if (operator === "^") set.push(...caret(partial));
    else if (operator === "") set.push(...xRange(partial));
    else set.push(...primitive(operator as Operator, partial));
  }
  return set;
};

export type Range = IComparator[][];

/** A range (`^1.2.0 || >=3 <4`), or undefined if it isn't a valid one. */
export const parseRange = (text: string): Range | undefined => {
  const sets: Range = [];
  for (const part of text.split("||")) {
    const set = parseComparatorSet(part);
    if (!set) return undefined;
    sets.push(set);
  }
  return sets;
};

const testSet = (set: IComparator[], version: ISemVer): boolean => {
  if (!set.every((comparator) => testComparator(comparator, version))) return false;
  if (!version.prerelease.length) return true;
  // The prerelease rule (see the header comment).
  return set.some(
    ({ version: bound }) =>
      bound.prerelease.length > 0 && bound.major === version.major && bound.minor === version.minor && bound.patch === version.patch,
  );
};

export const satisfies = (version: ISemVer, range: Range): boolean => range.some((set) => testSet(set, version));

/** The highest of `versions` that satisfies `range`. */
export const maxSatisfying = (versions: string[], range: Range): string | undefined => {
  let best: { text: string; version: ISemVer } | undefined;
  for (const text of versions) {
    const version = parseVersion(text);
    if (!version || !satisfies(version, range)) continue;
    if (!best || compareVersions(version, best.version) > 0) best = { text, version };
  }
  return best?.text;
};

/**
 * Does `range` allow everything `^version` allows? npm's own rule for what `npm install x@<range>`
 * saves to package.json: `^<installed version>` if that's no looser than what was asked for
 * (`x@7` saves `^7.8.5`), the typed range itself otherwise (`x@~1.1.0` stays `~1.1.0`). Compared
 * on comparator bounds alone - close enough for choosing what to write, not for resolution.
 */
export const coversCaret = (range: Range, version: ISemVer): boolean => {
  const [lower, upper] = caret(version);
  return range.some((set) =>
    set.every(({ operator, version: bound }) => {
      if (operator === "=") return false; // a single version never covers a whole ^ range
      if (operator === ">=") return compareVersions(lower.version, bound) >= 0;
      if (operator === ">") return compareVersions(lower.version, bound) > 0;
      return compareVersions(upper.version, bound) <= 0; // < or <=: ^'s own (exclusive) top must fit
    }),
  );
};
