// What a test keys on to run on every fast-check in `packages/tea/fast-check-peers`.
// Only test files import this, so it reaches no published entry point.

import * as fc from "fast-check";

/** The major of the fast-check that is loaded. */
export const MAJOR = Number(fc.__version.split(".")[0]);

/**
 * Whether the loaded fast-check reads `errorWithCause`. It records every setting it
 * reads in `runConfiguration`, and the oldest 3s and every 4 leave this one out.
 */
export const HAS_ERROR_WITH_CAUSE =
  "errorWithCause" in
  fc.check(
    fc.property(fc.constant(0), () => true),
    { numRuns: 1 },
  ).runConfiguration;
