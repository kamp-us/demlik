// ═══════════════════════════════════════════════════════════════════════════
// THE TEST RUNNER RESOLVES THE PUBLISHED SPECIFIER — every subpath, not most.
//
// `examples/*.ts` import `@demlik/tea/…`, and this test imports the published
// specifier directly, so `vitest.config.ts` aliases it back at `src/`. That
// alias used to be a GUESS — `@demlik/tea/(.*)` → `src/$1/index.ts`
// — which is right for most subpaths and wrong for the FLAT modules
// (`extension/react`, `extension/test-utils`) and for the one subpath that is
// not a module at all (`devtools/styles.css`). Nothing imported those through
// the specifier yet, so the breakage was latent: the FIRST test or example to
// do so would have died with a module-not-found naming a directory that never
// existed.
//
// The alias is now DERIVED from `package.json`'s `exports` — including the one
// subpath whose source extension is not `.ts` (`extension/react` ships from
// `react.tsx`). This file is the check that the derivation resolves. The
// imports are STATIC and at module scope on purpose: a bad alias then fails at
// COLLECT time, which is the failure mode a consumer would actually hit, and
// `import()` inside a case would defer it into a rejected promise.
// ═══════════════════════════════════════════════════════════════════════════
import { defineMachine } from "@demlik/tea";
import * as extReact from "@demlik/tea/extension/react";
import * as extTestUtils from "@demlik/tea/extension/test-utils";
import { backoffDelay } from "@demlik/tea/retry-backoff";
import { describe, expect, it } from "vitest";

describe("every published subpath shape resolves under the test alias", () => {
  it("resolves the flat module extension/test-utils", () => {
    // The `/(.*)/index.ts` guess sent this to a directory that is not there.
    expect(Object.keys(extTestUtils).length).toBeGreaterThan(0);
  });

  it("resolves a flat module whose SOURCE extension is not .ts", () => {
    // `exports` says `./dist/extension/react.js`; the source is `react.tsx`.
    // A `.js` → `.ts` rewrite alone lands on a file that does not exist, so the
    // alias has to probe the real extension rather than assume one.
    expect(Object.keys(extReact).length).toBeGreaterThan(0);
  });

  it("resolves the `index.ts` shape it always did", () => {
    expect(typeof backoffDelay).toBe("function");
  });

  it("resolves the bare root", () => {
    expect(typeof defineMachine).toBe("function");
  });
});
