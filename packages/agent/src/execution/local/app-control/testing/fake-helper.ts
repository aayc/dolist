/** Test support for starting the fake `ddl-computer` (`fake-computer-helper.ts`). Tests only. */
import { fileURLToPath } from "node:url";

/** The fake helper script; run it with `process.execPath`. */
export const FAKE_HELPER = fileURLToPath(new URL("./fake-computer-helper.ts", import.meta.url));

/**
 * How long tests let the fake helper take to answer `hello`. The real helper answers at once; the
 * fake is a Node process that strips its own types first, and on a busy machine, with other tests
 * starting helpers too, that takes many seconds. A failure bound only.
 */
export const FAKE_HELPER_HELLO_TIMEOUT_MS = 60_000;

/** Test timeout for tests that start the fake helper, possibly several times. */
export const FAKE_HELPER_TEST_TIMEOUT_MS = 120_000;
