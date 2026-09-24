export interface Throttled<A extends unknown[]> {
  (...args: A): void;
  cancel(): void;
}

/** Leading + trailing throttle: fires immediately, then at most once per `ms` with the latest args. */
export function throttle<A extends unknown[]>(fn: (...args: A) => void, ms: number): Throttled<A> {
  let last = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: A | null = null;

  const invoke = (args: A) => {
    last = performance.now();
    fn(...args);
  };

  const throttled = ((...args: A) => {
    const remaining = ms - (performance.now() - last);
    if (remaining <= 0 && timer === undefined) {
      invoke(args);
      return;
    }
    pending = args;
    if (timer === undefined) {
      timer = setTimeout(
        () => {
          timer = undefined;
          const next = pending;
          pending = null;
          if (next) invoke(next);
        },
        Math.max(remaining, 0),
      );
    }
  }) as Throttled<A>;

  throttled.cancel = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    pending = null;
  };
  return throttled;
}
