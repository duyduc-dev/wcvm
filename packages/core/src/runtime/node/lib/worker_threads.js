// VENDORED VERBATIM from Node.js v24.18.0 - lib/worker_threads.js
// Source: https://github.com/nodejs/node/blob/v24.18.0/lib/worker_threads.js
// Only this header and the function wrapper are added; do not edit the body.
// Regenerate with: node scripts/vendor-node-lib.mjs
export default function (exports, require, module, process, internalBinding, primordials) {
'use strict';

const {
  isInternalThread,
  isMainThread,
  SHARE_ENV,
  resourceLimits,
  setEnvironmentData,
  getEnvironmentData,
  threadId,
  threadName,
  Worker,
} = require('internal/worker');

const {
  MessagePort,
  MessageChannel,
  markAsUncloneable,
  moveMessagePortToContext,
  receiveMessageOnPort,
  BroadcastChannel,
} = require('internal/worker/io');

const {
  postMessageToThread,
} = require('internal/worker/messaging');

const {
  markAsUntransferable,
  isMarkedAsUntransferable,
} = require('internal/buffer');

const { locks } = require('internal/locks');

module.exports = {
  isInternalThread,
  isMainThread,
  MessagePort,
  MessageChannel,
  markAsUncloneable,
  markAsUntransferable,
  isMarkedAsUntransferable,
  moveMessagePortToContext,
  receiveMessageOnPort,
  resourceLimits,
  postMessageToThread,
  threadId,
  threadName,
  SHARE_ENV,
  Worker,
  parentPort: null,
  workerData: null,
  BroadcastChannel,
  setEnvironmentData,
  getEnvironmentData,
  locks,
};

}
