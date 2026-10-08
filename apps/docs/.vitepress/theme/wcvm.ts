// The embedded editor only works on a cross-origin isolated page (SharedArrayBuffer), and never during the
// build's server-side render, so check it in the browser before launching.
export const isolated = (): boolean => typeof self !== "undefined" && self.crossOriginIsolated === true;
