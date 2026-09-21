// Caller-side fixture for syscall.test.ts. Plain .mjs importing the .ts source
// directly (Node strips types), so the test needs no build step.
import { parentPort, workerData } from "node:worker_threads";
import {
  createSyscallClient,
  encodeRequest,
  encodeString,
  decodeBytes,
  makeViews,
  DATA_BYTES,
} from "./syscall.ts";

const views = makeViews(workerData.sab);
const client = createSyscallClient({
  ...views,
  notify: (opcode) => parentPort.postMessage({ type: "syscall", opcode }),
});

const attempt = (fn) => {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    return { ok: false, code: error.code ?? String(error) };
  }
};

const results = {};

results.echo = attempt(() =>
  decodeBytes(client.call(1, encodeRequest([encodeString("hello")]))),
);
results.fail = attempt(() => client.call(2, encodeRequest([])));
results.oversizeRequest = attempt(() =>
  client.call(1, encodeRequest([new Uint8Array(DATA_BYTES)])),
);
results.oversizeResponse = attempt(() => client.call(3, encodeRequest([])));
// A second call proves the buffer was reset after an error response.
results.afterError = attempt(() =>
  decodeBytes(client.call(1, encodeRequest([encodeString("again")]))),
);

parentPort.postMessage({ type: "done", results });
