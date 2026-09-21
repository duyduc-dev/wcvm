// Caller-side fixture for fsServer.test.ts: exercises the real sync fs client
// from a worker thread, parked on Atomics.wait while the main thread serves it.
import { parentPort, workerData } from "node:worker_threads";
import { createSyscallClient, makeViews } from "../protocols/syscall";
import { createFsClient } from "./fsClient";

const views = makeViews(workerData.sab);
const fs = createFsClient(
  createSyscallClient({
    ...views,
    notify: () => parentPort.postMessage({ type: "syscall" }),
  }),
);

const enc = new TextEncoder();
const dec = new TextDecoder();
const attempt = (fn) => {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    return { ok: false, code: error.code ?? String(error) };
  }
};

const results = {};

fs.mkdir("/proj/src", { recursive: true });
fs.writeFile("/proj/src/a.txt", "hello");
results.read = dec.decode(fs.readFile("/proj/src/a.txt"));
results.readdir = fs.readdir("/proj");
results.exists = [fs.exists("/proj"), fs.exists("/nope")];
results.stat = fs.stat("/proj/src/a.txt");
results.missing = attempt(() => fs.readFile("/nope"));
results.enotdir = attempt(() => fs.readdir("/proj/src/a.txt"));

fs.symlink("/proj/src", "/link");
results.viaLink = dec.decode(fs.readFile("/link/a.txt"));
results.readlink = fs.readlink("/link");
results.realpath = fs.realpath("/link/a.txt");

fs.rename("/proj/src/a.txt", "/proj/b.txt");
results.renamed = [fs.exists("/proj/src/a.txt"), fs.exists("/proj/b.txt")];
fs.rm("/proj", { recursive: true });
results.removed = !fs.exists("/proj");

// fd layer
const fd = fs.open("/fd.txt", 0o102 /* O_RDWR | O_CREAT */);
fs.write(fd, enc.encode("abcdef"));
results.fstatSize = fs.fstat(fd).size;
results.fdRead = dec.decode(fs.read(fd, 3, 1));
fs.ftruncate(fd, 2);
fs.close(fd);
results.truncated = dec.decode(fs.readFile("/fd.txt"));
results.badFd = attempt(() => fs.close(fd));

// Bigger than the 1 MiB syscall window in both directions.
const big = new Uint8Array(2_500_000);
for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 0xff;
fs.writeFile("/big.bin", big);
results.bigSize = fs.stat("/big.bin").size;
const back = fs.readFile("/big.bin");
results.bigRoundTrip =
  back.length === big.length && back.every((v, i) => v === big[i]);

parentPort.postMessage({ type: "done", results });
