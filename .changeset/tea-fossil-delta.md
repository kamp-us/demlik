---
"@demlik/tea": patch
---

`@demlik/tea` now depends on `fossil-delta` 2.0.0, a small package with no dependencies of its own. `@demlik/tea/do` uses it to store an event log's recordings, which a later release adds, so the install gains one package that nothing reads yet.
