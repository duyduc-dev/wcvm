import { KernelMessage } from "../../bridges/models";

/** Turns a thrown value into the fields of an error reply (errno kept as `errorCode`). */
const toErrorFields = (cause: unknown) => {
  const errorMessage = cause instanceof Error ? cause.message : String(cause);
  const code = (cause as { code?: unknown } | null)?.code;
  return typeof code === "string"
    ? { errorMessage, errorCode: code }
    : { errorMessage };
};

const toErrorReply = (
  type: string,
  reqId: unknown,
  cause: unknown,
): KernelMessage =>
  reqId !== undefined
    ? { type: "kernel-response", reqId, ...toErrorFields(cause) }
    : { type: "kernel:error", messageType: type, ...toErrorFields(cause) };

export { toErrorReply, toErrorFields };
