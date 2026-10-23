---
"@demlik/code-graph": patch
---

code-graph now reads vitest type-test files as tests: `*.test-d.ts`, `*.spec-d.ts`, `*.test-d.tsx` and `*.spec-d.tsx`, beside `*.test.ts` and `*.spec.ts`. Their exports no longer show up in `--unreachable` as `dead`, a call from one counts as a test call (`only-called-from-tests`), and `--clusters` leaves them out of the production clusters.
