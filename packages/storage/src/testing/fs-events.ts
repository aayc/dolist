/**
 * Test helper for real file-system events. Tests only.
 *
 * On macOS, libuv serves every directory `fs.watch` of a process from one FSEvents stream, and
 * recreates it (starting from "now") whenever a watch is opened or closed. The new stream comes up
 * asynchronously, so a change made before it is live is never reported; on a busy machine that
 * takes a while. Before a test makes the change it asserts on, it proves events flow by repeating
 * a harmless change until its event arrives.
 */
export interface EventsFlowOptions {
  /** Gives up (and throws) after this long. A failure bound only. */
  timeoutMs?: number;
}

const FIRST_RETRY_MS = 100;
const MAX_RETRY_MS = 1_000;

/**
 * Calls `poke(attempt)` (a change whose event the test can see) until `arrived()` holds, waiting
 * longer between attempts each time.
 */
export async function untilEventsFlow(
  poke: (attempt: number) => Promise<void>,
  arrived: () => boolean,
  { timeoutMs = 20_000 }: EventsFlowOptions = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let wait = FIRST_RETRY_MS;
  for (let attempt = 0; ; attempt++) {
    await poke(attempt);
    const retryAt = Math.min(Date.now() + wait, deadline);
    while (!arrived() && Date.now() < retryAt) await sleep(10);
    if (arrived()) return;
    if (Date.now() >= deadline) {
      throw new Error(`no file-system event arrived within ${timeoutMs} ms`);
    }
    wait = Math.min(wait * 2, MAX_RETRY_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
