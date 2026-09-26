import type { IFsClient } from "../fs/fsClient";

/** Removes every entry directly under `/` (not `/` itself), recursively. Each removal goes
 *  through the same fs.rm() path the OPFS write-behind mirror already watches (see
 *  fs/opfsPersistence.ts), so persisted storage is cleared too, if enabled - no separate OPFS
 *  code needed here. */
const resetFs = (fs: IFsClient): void => {
  for (const name of fs.readdir("/")) {
    fs.rm(`/${name}`, { recursive: true });
  }
};

export { resetFs };
