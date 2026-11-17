---
"@demlik/tea": minor
---

Publish the experimental `journalConformance` runner with `JournalKitFixture`,
`JournalKitFactory`, `KitResult`, `KitCase` and `KitOptions` from `@demlik/tea/pbt`.
Host authors can check their own journal drivers against K1–K8 with fast-check
alone, read each case's result, and replay generated failures. The Vitest wrapper
remains internal and `@demlik/tea/testing` still loads without fast-check.
