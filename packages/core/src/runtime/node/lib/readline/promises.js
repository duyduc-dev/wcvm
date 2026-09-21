// VENDORED VERBATIM from Node.js v24.18.0 - lib/readline/promises.js
// Source: https://github.com/nodejs/node/blob/v24.18.0/lib/readline/promises.js
// Only this header and the function wrapper are added; do not edit the body.
// Regenerate with: node scripts/vendor-node-lib.mjs
export default function (exports, require, module, process, internalBinding, primordials) {
'use strict';

const {
  Promise,
  SymbolDispose,
} = primordials;

const {
  Readline,
} = require('internal/readline/promises');

const {
  Interface: _Interface,
  kQuestion,
  kQuestionCancel,
  kQuestionReject,
} = require('internal/readline/interface');

const {
  AbortError,
} = require('internal/errors');
const { validateAbortSignal } = require('internal/validators');

const {
  kEmptyObject,
} = require('internal/util');
let addAbortListener;

class Interface extends _Interface {
  question(query, options = kEmptyObject) {
    return new Promise((resolve, reject) => {
      let cb = resolve;

      if (options?.signal) {
        validateAbortSignal(options.signal, 'options.signal');
        if (options.signal.aborted) {
          return reject(
            new AbortError(undefined, { cause: options.signal.reason }));
        }

        const onAbort = () => {
          this[kQuestionCancel]();
          reject(new AbortError(undefined, { cause: options.signal.reason }));
        };
        addAbortListener ??= require('internal/events/abort_listener').addAbortListener;
        const disposable = addAbortListener(options.signal, onAbort);

        cb = (answer) => {
          disposable[SymbolDispose]();
          resolve(answer);
        };
      }

      this[kQuestionReject] = reject;

      this[kQuestion](query, cb);
    });
  }
}

function createInterface(input, output, completer, terminal) {
  return new Interface(input, output, completer, terminal);
}

module.exports = {
  Interface,
  Readline,
  createInterface,
};

}
