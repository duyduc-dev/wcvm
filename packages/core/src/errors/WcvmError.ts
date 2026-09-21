type WcvmRuntimeErrorType =
  | "ERR_NOT_ISOLATED"
  | "ERR_WORKER"
  | "ERR_NOT_IMPLEMENTED"
  | "ERR_BOOT_TIMEOUT";

type WcvmErrorType = "WcvmError" | WcvmRuntimeErrorType;

class WcvmError extends Error {
  private readonly _type: WcvmErrorType;

  constructor(type: WcvmErrorType, message: string, options?: ErrorOptions) {
    super(message, options);
    this._type = type;
    this.name = "WcvmError";
  }

  get type(): WcvmErrorType {
    return this._type;
  }
}

export { WcvmError };
