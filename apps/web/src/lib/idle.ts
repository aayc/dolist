/** Runs `cb` when the main thread is idle (falls back to a short timeout where unsupported, e.g. WebKit). */
export function onIdle(cb: () => void, timeout = 2000): () => void {
  if (typeof requestIdleCallback === "function") {
    const id = requestIdleCallback(() => cb(), { timeout });
    return () => cancelIdleCallback(id);
  }
  const timer = setTimeout(cb, 150);
  return () => clearTimeout(timer);
}

/**
 * Calls `cb` right after the next frame has been produced: rAF runs before paint, and a message
 * posted from inside it is delivered after the paint. Used to measure "content visible" latency.
 */
export function afterNextPaint(cb: () => void): void {
  requestAnimationFrame(() => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      cb();
    };
    channel.port2.postMessage(null);
  });
}
