// `internalBinding('performance')`: what Node's real, vendored perf_hooks (lib/perf_hooks.js and
// internal/perf/*, internal/histogram.js) reach for in C++. Timing comes from the platform's own
// `performance` (captured at module load - CLAUDE.md's "never call a global by its bare name"
// gotcha); the rest is bookkeeping with no native counterpart to wire to:
//  - there are no garbage-collection/http2/net/dns entries for a native side to push (JS can't see
//    GC, and our net/http are JS all the way down), so `observerCounts`/`setupObservers`/the GC
//    tracking hooks only need to exist - a PerformanceObserver for 'mark'/'measure' is pure JS in
//    internal/perf/observe.js and works for real;
//  - `Histogram` stands in for Node's C++ HdrHistogram with EXACT values (a value -> count map), so
//    percentiles are precise rather than HDR's 3-significant-figure buckets, but follow the same
//    rules (see `percentile`/`percentiles`, checked against real Node's own output).

const nativePerformance = globalThis.performance;
const nativeSetInterval = globalThis.setInterval.bind(globalThis);
const nativeClearInterval = globalThis.clearInterval.bind(globalThis);

// node_perf_common.h's own orders - they're indices into `milestones`/`observerCounts`.
const MILESTONES = ["TIME_ORIGIN", "TIME_ORIGIN_TIMESTAMP", "ENVIRONMENT", "NODE_START", "V8_START", "LOOP_START", "LOOP_EXIT", "BOOTSTRAP_COMPLETE"];
const ENTRY_TYPES = ["GC", "HTTP", "HTTP2", "NET", "DNS"];

/** INT64_MAX: HdrHistogram's `min` before anything is recorded (as a Number, it rounds up). */
const INT64_MAX = 9223372036854775807n;

/** Node's C++ histogram handle (histogram.cc's HistogramImpl), exact rather than HDR-bucketed. */
export class Histogram {
  private counts = new Map<number, number>();
  private sorted: number[] | undefined;
  private total = 0;
  private sum = 0;
  private sumOfSquares = 0;
  private minimum = Infinity;
  private maximum = 0;
  private previousDelta = 0;

  record(value: number | bigint): void {
    const v = Number(value);
    this.counts.set(v, (this.counts.get(v) ?? 0) + 1);
    this.sorted = undefined;
    this.total++;
    this.sum += v;
    this.sumOfSquares += v * v;
    this.minimum = Math.min(this.minimum, v);
    this.maximum = Math.max(this.maximum, v);
  }

  /** Records the nanoseconds since the previous call (nothing on the first one). */
  recordDelta(): void {
    const now = nativePerformance.now() * 1e6;
    if (this.previousDelta > 0) this.record(Math.round(now - this.previousDelta));
    this.previousDelta = now;
  }

  add(other: Histogram): void {
    for (const [value, count] of other.counts) for (let i = 0; i < count; i++) this.record(value);
  }

  reset(): void {
    this.counts.clear();
    this.sorted = undefined;
    this.total = this.sum = this.sumOfSquares = this.maximum = this.previousDelta = 0;
    this.minimum = Infinity;
  }

  count(): number {
    return this.total;
  }
  countBigInt(): bigint {
    return BigInt(this.total);
  }
  min(): number {
    return this.total ? this.minimum : Number(INT64_MAX);
  }
  minBigInt(): bigint {
    return this.total ? BigInt(this.minimum) : INT64_MAX;
  }
  max(): number {
    return this.maximum;
  }
  maxBigInt(): bigint {
    return BigInt(this.maximum);
  }
  mean(): number {
    return this.total ? this.sum / this.total : Number.NaN;
  }
  /** Population standard deviation, like HdrHistogram's. */
  stddev(): number {
    if (!this.total) return Number.NaN;
    const mean = this.sum / this.total;
    return Math.sqrt(Math.max(0, this.sumOfSquares / this.total - mean * mean));
  }
  /** Values above the trackable range - never, since every value is kept exactly. */
  exceeds(): number {
    return 0;
  }
  exceedsBigInt(): bigint {
    return 0n;
  }

  /** The smallest recorded value with at least ceil(p% of count) values at or below it. */
  percentile(p: number): number {
    if (!this.total) return 0;
    this.sorted ??= [...this.counts.keys()].sort((a, b) => a - b);
    const target = Math.max(1, Math.ceil((p / 100) * this.total));
    let seen = 0;
    for (const value of this.sorted) {
      seen += this.counts.get(value)!;
      if (seen >= target) return value;
    }
    return this.maximum;
  }
  percentileBigInt(p: number): bigint {
    return BigInt(this.percentile(p));
  }

  /** HdrHistogram's percentile iteration: 0, 50, 75, 87.5, ... - halving what's left each step -
   *  until the maximum is reached, then 100. An empty histogram is just `100 => 0`. */
  percentiles(map: Map<number, number>): void {
    if (!this.total) {
      map.set(100, 0);
      return;
    }
    for (let p = 0, remaining = 100; ; remaining /= 2, p = 100 - remaining) {
      const value = this.percentile(p);
      map.set(p, value);
      if (value >= this.maximum) break;
    }
    map.set(100, this.maximum);
  }
  percentilesBigInt(map: Map<number, bigint>): void {
    const numbers = new Map<number, number>();
    this.percentiles(numbers);
    for (const [p, value] of numbers) map.set(p, BigInt(value));
  }
}

/** `monitorEventLoopDelay()`'s handle: samples, every `resolution` ms, how long it really took
 *  for the next tick to arrive (in ns) - late ticks are the event loop's delay. The platform timer
 *  it runs on doesn't keep the process alive, like Node's own unref'd one. */
class ELDHistogram extends Histogram {
  private timer: ReturnType<typeof nativeSetInterval> | undefined;
  private readonly resolution: number;

  constructor(resolution: number) {
    super();
    this.resolution = resolution;
  }

  start(): boolean {
    if (this.timer !== undefined) return false;
    let previous = nativePerformance.now();
    this.timer = nativeSetInterval(() => {
      const now = nativePerformance.now();
      this.record(Math.max(1, Math.round((now - previous) * 1e6)));
      previous = now;
    }, this.resolution);
    return true;
  }

  stop(): boolean {
    if (this.timer === undefined) return false;
    nativeClearInterval(this.timer);
    this.timer = undefined;
    return true;
  }
}

// milestones[] are nanoseconds on a monotonic clock (-1 = not reached); `now()` is milliseconds
// since the time origin. TIME_ORIGIN is the monotonic reading at start, TIME_ORIGIN_TIMESTAMP the
// wall clock (microseconds). A process worker's start stands in for every startup milestone.
export const createPerformanceBinding = () => {
  const constants: Record<string, number> = {};
  MILESTONES.forEach((name, i) => (constants[`NODE_PERFORMANCE_MILESTONE_${name}`] = i));
  ENTRY_TYPES.forEach((name, i) => (constants[`NODE_PERFORMANCE_ENTRY_TYPE_${name}`] = i));

  const originMs = nativePerformance.now();
  const milestones = new Float64Array(MILESTONES.length).fill(-1);
  milestones[constants.NODE_PERFORMANCE_MILESTONE_TIME_ORIGIN] = originMs * 1e6;
  milestones[constants.NODE_PERFORMANCE_MILESTONE_TIME_ORIGIN_TIMESTAMP] = (nativePerformance.timeOrigin + originMs) * 1e3;
  for (const name of ["ENVIRONMENT", "NODE_START", "V8_START", "BOOTSTRAP_COMPLETE"]) {
    milestones[constants[`NODE_PERFORMANCE_MILESTONE_${name}`]] = originMs * 1e6;
  }

  return {
    constants,
    milestones,
    observerCounts: new Uint32Array(ENTRY_TYPES.length),
    now: () => nativePerformance.now() - originMs,
    loopIdleTime: () => 0,
    uvMetricsInfo: () => [0, 0, 0],
    setupObservers: () => {},
    installGarbageCollectionTracking: () => {},
    removeGarbageCollectionTracking: () => {},
    notify: () => {},
    Histogram,
    createELDHistogram: (resolution: number) => new ELDHistogram(resolution),
  };
};
