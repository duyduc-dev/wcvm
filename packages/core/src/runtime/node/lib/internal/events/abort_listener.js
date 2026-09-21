// VENDORED VERBATIM from Node.js v24.18.0 - lib/internal/events/abort_listener.js
// Source: https://github.com/nodejs/node/blob/v24.18.0/lib/internal/events/abort_listener.js
// Only this header and the function wrapper are added; do not edit the body.
// Regenerate with: node scripts/vendor-node-lib.mjs
export default function (exports, require, module, process, internalBinding, primordials) {
'use strict';

const {
  SymbolDispose,
} = primordials;
const {
  validateAbortSignal,
  validateFunction,
} = require('internal/validators');
const {
  codes: {
    ERR_INVALID_ARG_TYPE,
  },
} = require('internal/errors');

let queueMicrotask;
let kResistStopPropagation;

/**
 * @param {AbortSignal} signal
 * @param {EventListener} listener
 * @returns {Disposable}
 */
function addAbortListener(signal, listener) {
  if (signal === undefined) {
    throw new ERR_INVALID_ARG_TYPE('signal', 'AbortSignal', signal);
  }
  validateAbortSignal(signal, 'signal');
  validateFunction(listener, 'listener');

  let removeEventListener;
  if (signal.aborted) {
    queueMicrotask ??= require('internal/process/task_queues').queueMicrotask;
    queueMicrotask(() => listener());
  } else {
    kResistStopPropagation ??= require('internal/event_target').kResistStopPropagation;
    // TODO(atlowChemi) add { subscription: true } and return directly
    signal.addEventListener('abort', listener, { __proto__: null, once: true, [kResistStopPropagation]: true });
    removeEventListener = () => {
      signal.removeEventListener('abort', listener);
    };
  }
  return {
    __proto__: null,
    [SymbolDispose]() {
      removeEventListener?.();
    },
  };
}

module.exports = {
  __proto__: null,
  addAbortListener,
};

}
