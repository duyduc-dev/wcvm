// VENDORED VERBATIM from Node.js v24.18.0 - lib/internal/process/permission.js
// Source: https://github.com/nodejs/node/blob/v24.18.0/lib/internal/process/permission.js
// Only this header and the function wrapper are added; do not edit the body.
// Regenerate with: node scripts/vendor-node-lib.mjs
export default function (exports, require, module, process, internalBinding, primordials) {
'use strict';

const {
  ObjectFreeze,
} = primordials;

const permission = internalBinding('permission');
const { validateString, validateBuffer } = require('internal/validators');
const { Buffer } = require('buffer');
const { isBuffer } = Buffer;

let _permission;

module.exports = ObjectFreeze({
  __proto__: null,
  isEnabled() {
    if (_permission === undefined) {
      const { getOptionValue } = require('internal/options');
      _permission = getOptionValue('--permission');
    }
    return _permission;
  },
  has(scope, reference) {
    validateString(scope, 'scope');
    if (reference != null) {
      // TODO: add support for WHATWG URLs and Uint8Arrays.
      if (isBuffer(reference)) {
        validateBuffer(reference, 'reference');
      } else {
        validateString(reference, 'reference');
      }
    }

    return permission.has(scope, reference);
  },
  availableFlags() {
    return [
      '--allow-fs-read',
      '--allow-fs-write',
      '--allow-addons',
      '--allow-child-process',
      '--allow-inspector',
      '--allow-wasi',
      '--allow-worker',
    ];
  },
});

}
