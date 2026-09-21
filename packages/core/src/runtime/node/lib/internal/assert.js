// VENDORED VERBATIM from Node.js v24.18.0 - lib/internal/assert.js
// Source: https://github.com/nodejs/node/blob/v24.18.0/lib/internal/assert.js
// Only this header and the function wrapper are added; do not edit the body.
// Regenerate with: node scripts/vendor-node-lib.mjs
export default function (exports, require, module, process, internalBinding, primordials) {
'use strict';

let error;
function lazyError() {
  return error ??= require('internal/errors').codes.ERR_INTERNAL_ASSERTION;
}

function assert(value, message) {
  if (!value) {
    const ERR_INTERNAL_ASSERTION = lazyError();
    throw new ERR_INTERNAL_ASSERTION(message);
  }
}

function fail(message) {
  const ERR_INTERNAL_ASSERTION = lazyError();
  throw new ERR_INTERNAL_ASSERTION(message);
}

assert.fail = fail;

module.exports = assert;

}
