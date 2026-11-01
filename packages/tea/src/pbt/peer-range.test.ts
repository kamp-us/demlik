import * as fc from "fast-check";
import { expect, it } from "vitest";

// The root vitest config runs `src/pbt` on each folder in `packages/tea/fast-check-peers`.
// If a project's alias ever stopped working it would test the dev pin under another
// version's name, and read green. tea's own project sets no version, and checks nothing.
it("runs on the fast-check its project names", () => {
  expect(fc.__version).toBe(process.env.TEA_FAST_CHECK_PEER ?? fc.__version);
});
