---
"@demlik/code-graph": minor
---

A bump policy rule can accept a second changeset marker. `--api-policy` reads `"callout": { "or": "<second marker>" }` on a rule, met when a counted changeset's body carries the policy's `callout` or that text, so a package can let a `changed` row take a marker saying the change is not a break while `removed` still needs the callout. A miss names both markers. The verdict gains `otherMarkersFound`, the second markers found, and `@demlik/code-graph/api` gains `calloutMet(rule, verdict)` for a caller that prints its own verdict. A policy with no second marker is judged and printed as before, apart from `otherMarkersFound: []` in `--json`. A rule's `callout` type is now `boolean | { or: string }`, so code that reads it as a plain boolean needs to handle the third form once a policy uses it.
