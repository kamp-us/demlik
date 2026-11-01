---
"@demlik/code-graph": patch
---

`--api` now works on a package whose tsconfig sets `declarationDir`, whether directly or through `extends`. It used to write its declarations into that folder and then exit 2, blaming `include`. The emit now goes to the temp folder like every other package's, so the view, `--api-base`, `--api-policy` and the API ledger read the same as if the option were not set, and the checkout stays untouched.
