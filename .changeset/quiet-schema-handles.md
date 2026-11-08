---
"@demlik/tea": minor
---

**Additive (declaration only):** `Machine.make` on `@demlik/tea/effect` exposes
readonly `model` and `msg` properties with the original Effect schema references
and inferred decoded types. Hosts can validate saved models and incoming plain
messages through those references. Construction, boot and dispatch still perform
no automatic schema decoding.
