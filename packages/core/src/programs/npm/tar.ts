// A tar reader - just enough for npm package tarballs (after gunzip): ustar headers (with the
// 155-byte `prefix` field for longer paths), pax extended headers (`x`, for paths/sizes that don't
// fit a header at all) and GNU long names (`L`/`K`), since real registries have tarballs made by
// every tar writer there has ever been.
//
// Links are reported but never followed or created by the installer - npm itself doesn't extract
// them either (a package tarball has no business pointing outside itself).

export type TarEntryType = "file" | "directory" | "symlink" | "link" | "other";

export interface ITarEntry {
  path: string;
  type: TarEntryType;
  mode: number;
  data: Uint8Array;
  linkpath?: string;
}

export class TarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TarError";
  }
}

const BLOCK = 512;
const latin1 = new TextDecoder("latin1");
const utf8 = new TextDecoder();

/** Everything before the first NUL (header fields and GNU long names are NUL-terminated). */
const beforeNul = (value: string): string => {
  const nul = value.indexOf("\0");
  return nul === -1 ? value : value.slice(0, nul);
};

/** A NUL-terminated header field. Names are UTF-8 in practice (every modern writer), not ASCII. */
const text = (block: Uint8Array, offset: number, length: number): string => {
  const field = block.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return utf8.decode(end === -1 ? field : field.subarray(0, end));
};

/** An octal number field - or, with the high bit of its first byte set, GNU base-256 (sizes >= 8 GiB). */
const number = (block: Uint8Array, offset: number, length: number): number => {
  const field = block.subarray(offset, offset + length);
  if (field[0] & 0x80) {
    let value = field[0] & 0x7f;
    for (let i = 1; i < field.length; i++) value = value * 256 + field[i];
    return value;
  }
  const digits = beforeNul(latin1.decode(field)).trim();
  if (digits === "") return 0;
  if (!/^[0-7]+$/.test(digits)) throw new TarError(`Invalid octal field: ${JSON.stringify(digits)}`);
  return Number.parseInt(digits, 8);
};

const checksumMatches = (block: Uint8Array): boolean => {
  const stored = number(block, 148, 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : block[i];
  return sum === stored;
};

/** pax records: `<length> <key>=<value>\n`, where length counts the whole record in bytes. */
const parsePax = (data: Uint8Array): Record<string, string> => {
  const records: Record<string, string> = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number(latin1.decode(data.subarray(offset, space)));
    if (!Number.isInteger(length) || length <= 0 || offset + length > data.length) throw new TarError("Malformed pax header");
    const record = utf8.decode(data.subarray(space + 1, offset + length - 1)); // minus the trailing \n
    const eq = record.indexOf("=");
    if (eq !== -1) records[record.slice(0, eq)] = record.slice(eq + 1);
    offset += length;
  }
  return records;
};

const TYPES: Record<string, TarEntryType> = { "0": "file", "\0": "file", "7": "file", "5": "directory", "2": "symlink", "1": "link" };

export const untar = (archive: Uint8Array): ITarEntry[] => {
  const entries: ITarEntry[] = [];
  let pax: Record<string, string> = {};
  let globalPax: Record<string, string> = {};
  let longName: string | undefined;
  let longLink: string | undefined;

  for (let offset = 0; offset + BLOCK <= archive.length; ) {
    const header = archive.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break; // end of archive (two zero blocks; one is enough to stop)
    if (!checksumMatches(header)) throw new TarError(`Bad header checksum at offset ${offset}`);

    const typeflag = String.fromCodePoint(header[156]);
    const overrides = { ...globalPax, ...pax };
    const size = overrides.size === undefined ? number(header, 124, 12) : Number(overrides.size);
    const dataStart = offset + BLOCK;
    if (dataStart + size > archive.length) throw new TarError("Archive is truncated");
    const data = archive.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    // Meta entries describe the NEXT real entry, rather than being one themselves.
    if (typeflag === "x") {
      pax = parsePax(data);
      continue;
    }
    if (typeflag === "g") {
      globalPax = { ...globalPax, ...parsePax(data) };
      continue;
    }
    if (typeflag === "L") {
      longName = beforeNul(utf8.decode(data));
      continue;
    }
    if (typeflag === "K") {
      longLink = beforeNul(utf8.decode(data));
      continue;
    }

    const isUstar = latin1.decode(header.subarray(257, 262)) === "ustar";
    const prefix = isUstar ? text(header, 345, 155) : "";
    const name = text(header, 0, 100);
    const path = overrides.path ?? longName ?? (prefix ? `${prefix}/${name}` : name);
    const linkpath = overrides.linkpath ?? longLink ?? text(header, 157, 100);
    const type = TYPES[typeflag] ?? "other";
    entries.push({ path, type, mode: number(header, 100, 8), data, ...(type === "symlink" || type === "link" ? { linkpath } : {}) });

    pax = {};
    longName = undefined;
    longLink = undefined;
  }
  return entries;
};
