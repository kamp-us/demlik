---
"@demlik/code-graph": patch
---

code-graph now reads `*.type-test.ts` and `*.type-test.tsx` files as tests, beside `*.test.ts`, `*.spec.ts` and `*.test-d.ts`. Their exports no longer show up in `--unreachable` as `unused-export` or `dead`, an export used only from one reports as `only-called-from-tests`, and the module's `isTest` and the comment census say test. A public function that only such a file calls is no longer counted as reached, so it moves to `withheld` as `public-entry-surface`. The exact name is required, so a production file such as `load-test.ts` stays production code.
