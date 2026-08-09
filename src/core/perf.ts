const PREFIX = "dfp";

/** Cheap wrapper so every measurement lands in the same namespace and shows up
 *  in DevTools' Performance panel next to Discourse's own marks. */
export function measure<T>(name: string, fn: () => T): { value: T; ms: number } {
  const start = performance.now();
  try {
    const value = fn();
    return { value, ms: performance.now() - start };
  } finally {
    const end = performance.now();
    try {
      performance.measure(`${PREFIX}:${name}`, { start, end });
    } catch {
      // performance.measure can throw if the buffer is exhausted. Never fatal.
    }
  }
}

export function mark(name: string): void {
  try {
    performance.mark(`${PREFIX}:${name}`);
  } catch {
    /* buffer exhausted */
  }
}
