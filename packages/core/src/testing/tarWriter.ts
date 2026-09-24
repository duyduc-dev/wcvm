// A minimal tar WRITER, for tests only (the installer only ever reads tarballs -
// programs/npm/tar.ts): builds ustar entries plus the pax/GNU meta entries real tarballs use.

const BLOCK = 512;
const encoder = new TextEncoder();

export interface ITarEntrySpec {
  name?: string;
  data?: string | Uint8Array;
  typeflag?: string;
  mode?: number;
  linkname?: string;
  /** Emits a pax `x` header (applies to the next entry) instead of an ordinary entry. */
  pax?: Record<string, string>;
  /** Emits a pax `g` header (applies to every later entry). */
  globalPax?: Record<string, string>;
  /** Emits a GNU `L` long-name entry (applies to the next entry). */
  gnuLongName?: string;
  /** Emits a GNU `K` long-linkname entry (applies to the next entry). */
  gnuLongLink?: string;
}

const writeText = (block: Uint8Array, offset: number, length: number, value: string) => {
  block.set(encoder.encode(value).subarray(0, length), offset);
};
const writeOctal = (block: Uint8Array, offset: number, length: number, value: number) => {
  writeText(block, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
};

const paxBody = (records: Record<string, string>): Uint8Array => {
  let out = "";
  for (const [key, value] of Object.entries(records)) {
    const body = ` ${key}=${value}\n`;
    // The length prefix counts itself - find the fixed point.
    let length = encoder.encode(body).length + 1;
    while (String(length).length + encoder.encode(body).length !== length) length++;
    out += `${length}${body}`;
  }
  return encoder.encode(out);
};

const header = (name: string, typeflag: string, size: number, mode: number, linkname: string): Uint8Array => {
  const block = new Uint8Array(BLOCK);
  writeText(block, 0, 100, name);
  writeOctal(block, 100, 8, mode);
  writeOctal(block, 108, 8, 0);
  writeOctal(block, 116, 8, 0);
  writeOctal(block, 124, 12, size);
  writeOctal(block, 136, 12, 0);
  block[156] = typeflag.charCodeAt(0);
  writeText(block, 157, 100, linkname);
  writeText(block, 257, 6, "ustar\0");
  writeText(block, 263, 2, "00");
  block.fill(0x20, 148, 156);
  const sum = block.reduce((a, b) => a + b, 0);
  writeText(block, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return block;
};

const padded = (data: Uint8Array): Uint8Array => {
  const out = new Uint8Array(Math.ceil(data.length / BLOCK) * BLOCK);
  out.set(data);
  return out;
};

export const tarEntry = (spec: ITarEntrySpec): Uint8Array => {
  let name = spec.name ?? "";
  let typeflag = spec.typeflag ?? "0";
  let data: Uint8Array = typeof spec.data === "string" ? encoder.encode(spec.data) : (spec.data ?? new Uint8Array(0));
  if (spec.pax) [name, typeflag, data] = ["PaxHeader", "x", paxBody(spec.pax)];
  if (spec.globalPax) [name, typeflag, data] = ["GlobalHead", "g", paxBody(spec.globalPax)];
  if (spec.gnuLongName !== undefined) [name, typeflag, data] = ["././@LongLink", "L", encoder.encode(`${spec.gnuLongName}\0`)];
  if (spec.gnuLongLink !== undefined) [name, typeflag, data] = ["././@LongLink", "K", encoder.encode(`${spec.gnuLongLink}\0`)];
  const block = header(name, typeflag, data.length, spec.mode ?? 0o644, spec.linkname ?? "");
  const out = new Uint8Array(BLOCK + Math.ceil(data.length / BLOCK) * BLOCK);
  out.set(block);
  out.set(padded(data), BLOCK);
  return out;
};

/** Concatenates entries and appends the two zero blocks that end an archive. */
export const tarArchive = (entries: Uint8Array[]): Uint8Array => {
  const total = entries.reduce((n, e) => n + e.length, 0) + 2 * BLOCK;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const entry of entries) {
    out.set(entry, offset);
    offset += entry.length;
  }
  return out;
};
