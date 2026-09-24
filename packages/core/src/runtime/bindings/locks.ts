// internalBinding('locks'): backs Node's real vendored internal/locks.js (the worker_threads
// `locks` export - the Web Locks API). The real, native `navigator.locks` is available in both
// Window and Worker global scopes per spec, so this is a thin, direct wrapper around it - Node's
// own Lock/LockManager classes are themselves modeled on the same Web Locks spec (createLock()
// reads `internalLock.name`/`.mode`, query()'s own return shape is `{held, pending}` - exactly
// what a real `Lock`/`navigator.locks.query()` already produce), so no translation is needed
// beyond the request()/query() call shape vendored code expects from this binding specifically.

type LockMode = "shared" | "exclusive";

export const createLocksBinding = () => {
  const nav = (globalThis as { navigator?: { locks?: LockManager } }).navigator;

  const request = (
    name: string,
    _clientId: string,
    mode: LockMode,
    steal: boolean,
    ifAvailable: boolean,
    callback: (lock: Lock | null) => unknown,
  ): Promise<unknown> => {
    if (!nav?.locks) return Promise.reject(new Error("the Web Locks API is not available in this environment"));
    return nav.locks.request(name, { mode, steal, ifAvailable }, (lock) => callback(lock));
  };

  const query = async (): Promise<{ held: object[]; pending: object[] }> => {
    const snapshot = await nav?.locks?.query();
    return { held: snapshot?.held ?? [], pending: snapshot?.pending ?? [] };
  };

  return {
    LOCK_MODE_SHARED: "shared" as LockMode,
    LOCK_MODE_EXCLUSIVE: "exclusive" as LockMode,
    // The exact string doesn't matter beyond staying internally consistent: internal/locks.js's
    // own convertLockError() only ever compares a caught error's `.message` against this same
    // constant (to turn a stolen-lock rejection into an AbortError DOMException) - real
    // navigator.locks.request({steal:true}) rejects a stolen lock's own held promise with a
    // plain AbortError already, so that comparison simply never matches here, which is fine:
    // the original error passes through unconverted instead, still a reasonable error either way.
    LOCK_STOLEN_ERROR: "wcvm:lock-stolen",
    request,
    query,
  };
};
