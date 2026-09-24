import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { TarError, untar } from "./tar";
import { tarEntry, tarArchive } from "../../testing/tarWriter";

// A real `npm pack` tarball (npm 11 / node-tar): an executable bin, a UTF-8 file, and a path
// longer than ustar's 100-byte name field, which node-tar splits into the 155-byte prefix field.
const NPM_PACK_TGZ =
  "H4sIAAAAAAAC/+2X3U7DIBSAe72nQLzRRFpYf5bM+DCsPeuYFCrQZWbZU3jrC/gcvolPYlqniZvGC7fGOb4b0kNLKOU7nNY8v+UlRBOholyKcG6DvUMpHaUp+irekVIUxGlGGcsymqCAMsbiGAU06IHGOm4CSvfwkpRS9NEeCednUWNN9/lBLZDSBQxyrayWEEpdXuBcCnx5PQg8/5ICoCZTIYEoXsFB9G+VyJLke/9jtuV/nGTZ8Mj9rzeJVYpJxInhbgaGSK1KUggDudPmvlty4jSpGzsjNbeOuBmQbkZEikq4iKuCcKW7h+8a4eBtCAtlBcqRGRj43bQrXTQSQljW2jiLbhBudwT2wp8I79tUqAKWh9H/Z//j7fOfjobMn/99sOv/8xN6eXzwGeC0/N+04dxq1bP/bJjt1P9pknr/+2CFcFuF4DHCbdUxFUvXGMBXCC/AWKFV28NCGtI2NhHt9erzveMuvvl7xGiN1j51eDwez5/nFRJjVMsAFAAA";

const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe("untar", () => {
  it("reads a real npm pack tarball: paths (prefix-split ones too), modes, and contents", () => {
    const entries = untar(gunzipSync(Buffer.from(NPM_PACK_TGZ, "base64")));
    expect(entries.map((e) => [e.path, e.type, e.mode & 0o777])).toEqual([
      ["package/bin/cli.js", "file", 0o755],
      [
        "package/lib/a-rather-long-directory-name-to-push-past-the-ustar-limit/and-another-quite-long-segment-here/deep-file-name.js",
        "file",
        0o644,
      ],
      ["package/index.js", "file", 0o644],
      ["package/package.json", "file", 0o644],
    ]);
    expect(text(entries[2].data)).toBe('module.exports = "é ✓";\n');
    expect(JSON.parse(text(entries[3].data))).toMatchObject({ name: "tar-fixture", version: "1.0.0" });
  });

  it("applies a pax header's path and size to the entry that follows it", () => {
    const long = `package/${"x".repeat(300)}/file.js`;
    const entries = untar(tarArchive([tarEntry({ pax: { path: long } }), tarEntry({ name: "package/short.js", data: "body" })]));
    expect(entries).toEqual([{ path: long, type: "file", mode: 0o644, data: new TextEncoder().encode("body") }]);
  });

  it("a global pax header applies to every later entry, an ordinary one only to the next", () => {
    const entries = untar(
      tarArchive([
        tarEntry({ globalPax: { comment: "ignored" } }),
        tarEntry({ pax: { path: "package/renamed.js" } }),
        tarEntry({ name: "package/a.js", data: "a" }),
        tarEntry({ name: "package/b.js", data: "b" }),
      ]),
    );
    expect(entries.map((e) => e.path)).toEqual(["package/renamed.js", "package/b.js"]);
  });

  it("applies a GNU long name/long link to the entry that follows it", () => {
    const long = `package/${"y".repeat(150)}.js`;
    const entries = untar(
      tarArchive([
        tarEntry({ gnuLongName: long }),
        tarEntry({ name: "trunc", data: "z" }),
        tarEntry({ gnuLongLink: "package/target-with-a-long-name.js" }),
        tarEntry({ name: "package/link", typeflag: "2", linkname: "short" }),
      ]),
    );
    expect(entries.map((e) => [e.path, e.type, e.linkpath])).toEqual([
      [long, "file", undefined],
      ["package/link", "symlink", "package/target-with-a-long-name.js"],
    ]);
  });

  it("reports directories and data padded to 512-byte blocks", () => {
    const big = "q".repeat(1300);
    const entries = untar(tarArchive([tarEntry({ name: "package/dir/", typeflag: "5" }), tarEntry({ name: "package/big.txt", data: big }), tarEntry({ name: "package/after.txt", data: "after" })]));
    expect(entries.map((e) => [e.path, e.type, e.data.length])).toEqual([
      ["package/dir/", "directory", 0],
      ["package/big.txt", "file", 1300],
      ["package/after.txt", "file", 5],
    ]);
  });

  it("stops at the end-of-archive zero block, ignoring anything after it", () => {
    const archive = tarArchive([tarEntry({ name: "package/a.js", data: "a" })]);
    const withJunk = new Uint8Array([...archive, ...new Uint8Array(512).fill(7)]);
    expect(untar(withJunk).map((e) => e.path)).toEqual(["package/a.js"]);
  });

  it("rejects a corrupted header and a truncated archive", () => {
    const archive = tarArchive([tarEntry({ name: "package/a.js", data: "a".repeat(600) })]);
    const corrupted = archive.slice();
    corrupted[10] ^= 0xff;
    expect(() => untar(corrupted)).toThrow(TarError);
    expect(() => untar(archive.subarray(0, 700))).toThrow(/truncated/);
  });
});
