import { inScope } from "../rules.js";
import type { BoundaryKind, BoundaryViolation } from "../violation.js";

// A test file sits in no zone: it may import any file of its own feature, read the clock and use
// the console. Which kinds still judge it is this one table, a row per kind, so a kind added later
// does not compile until someone decides. Which files are tests is the rules file's `testFiles`.
//
// B1 and B4 still judge what a test imports across features, B2 a test in a `rules/` folder (a
// `rules`-layout feature has no zone to be neutral in), B3 a test in `lib`, B5 a declared door
// opened outside its owners, B12 a library test importing upward, B14 an adapter library imported
// from outside a driven adapter, and B19 a relative path out of the workspace, whatever the file
// is named. B11 and B18 hold no file.
const JUDGES_TEST_FILES = {
  "cross-feature": true,
  "impure-rules": true,
  "lib-imports-feature": true,
  "outside-imports-feature-internal": true,
  "door-outside-owner": true,
  "application-imports-adapter": false,
  "impure-application": false,
  "driving-reaches-driven": false,
  "door-outside-driven-adapter": false,
  "unknown-zone": false,
  "library-undeclared": true,
  "library-imports-up": true,
  "impure-library": false,
  "adapter-library-imported-outside-driven": true,
  "index-not-exports-only": false,
  "application-import-outside-allowlist": false,
  "binding-outside-driven-adapter": false,
  "worker-call-cycle": true,
  "relative-import-crosses-workspace": true,
} as const satisfies Record<BoundaryKind, boolean>;

// Whether a scope's file matches one of the `testFiles` globs, by its scope-relative path or by its
// repo-relative one. At scope `.` the two are one path.
export function isTestFile(tests: readonly RegExp[], scope: string, file: string): boolean {
  const repoRelative = inScope(scope, file);
  return tests.some((glob) => glob.test(file) || glob.test(repoRelative));
}

// What a test file is left with once the kinds that do not judge it are dropped.
export function judgedInTestFile(violations: readonly BoundaryViolation[]): BoundaryViolation[] {
  return violations.filter((violation) => JUDGES_TEST_FILES[violation.kind]);
}
