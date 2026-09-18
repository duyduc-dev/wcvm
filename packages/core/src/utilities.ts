function isCrossOriginIsolated(): boolean {
  return typeof SharedArrayBuffer !== "undefined" && self.crossOriginIsolated;
}

export { isCrossOriginIsolated };
