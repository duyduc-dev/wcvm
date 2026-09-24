// VENDORED VERBATIM from Node.js v24.18.0 - lib/perf_hooks.js
// Source: https://github.com/nodejs/node/blob/v24.18.0/lib/perf_hooks.js
// Only this header and the function wrapper are added; do not edit the body.
// Regenerate with: node scripts/vendor-node-lib.mjs
export default function (exports, require, module, process, internalBinding, primordials) {
'use strict';

const {
  ObjectDefineProperty,
} = primordials;

const {
  constants,
} = internalBinding('performance');

const { PerformanceEntry } = require('internal/perf/performance_entry');
const { PerformanceResourceTiming } = require('internal/perf/resource_timing');
const {
  PerformanceObserver,
  PerformanceObserverEntryList,
} = require('internal/perf/observe');
const {
  PerformanceMark,
  PerformanceMeasure,
} = require('internal/perf/usertiming');
const {
  Performance,
  performance,
} = require('internal/perf/performance');

const {
  createHistogram,
} = require('internal/histogram');

const monitorEventLoopDelay = require('internal/perf/event_loop_delay');
const { eventLoopUtilization } = require('internal/perf/event_loop_utilization');
const timerify = require('internal/perf/timerify');

module.exports = {
  Performance,
  PerformanceEntry,
  PerformanceMark,
  PerformanceMeasure,
  PerformanceObserver,
  PerformanceObserverEntryList,
  PerformanceResourceTiming,
  monitorEventLoopDelay,
  eventLoopUtilization,
  timerify,
  createHistogram,
  performance,
};

ObjectDefineProperty(module.exports, 'constants', {
  __proto__: null,
  configurable: false,
  enumerable: true,
  value: constants,
});

}
