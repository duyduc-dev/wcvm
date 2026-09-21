type WcvmRuntimeErrorType =
  | "ERR_NOT_ISOLATED"
  | "ERR_WORKER"
  | "ERR_NOT_IMPLEMENTED"
  | "ERR_BOOT_TIMEOUT";

type WcvmErrorType = "WcvmError" | WcvmRuntimeErrorType;

class WcvmError extends Error {
  private readonly _type: WcvmErrorType;
  private readonly _code: string | undefined;

  constructor(
    type: WcvmErrorType,
    message: string,
    options?: ErrorOptions & { code?: string },
  ) {
    super(message, options);
    this._type = type;
    this._code = options?.code;
    this.name = "WcvmError";
  }

  /** errno-style code (e.g. `ENOENT`) when the failure came from the VFS. */
  get code(): string | undefined {
    return this._code;
  }

  get type(): WcvmErrorType {
    return this._type;
  }
}

export { WcvmError };
