---
"@demlik/tea": minor
---

Property tests on the Effect engine no longer need their answers written by hand. The first two items below are experimental.

- `@demlik/tea/testing/effect` gains `arbSchemaGuidedSequence`. It draws Msg lists for Effect's `Arbitrary.checkEffect`, and each answer comes from its Cmd's own Effect schema: an `ok` answer from `schema.ok`, an `err` answer with one of its `errTags`. Every answer answers a Cmd that was sent and not yet answered. A machine it cannot draw for gets a failed `Result`: `NoCmdsError`, `NotEffectSchemaError` naming the Cmd, or `NothingToDrawError`. It imports no fast-check.
- The laws are plain check functions: `lawTerminates`, `lawInvariant` and `lawTrace`, with `LawBreak`. Each reads one `foldEvents` result and answers `null` or what broke. `propertyTerminates`, `propertyInvariant` and `propertyTrace` call them, with the same messages as before. `@demlik/tea/pbt` and `@demlik/tea/testing/effect` both export them.

Stable, on the promise of the subpath that exports them:

- `@demlik/tea/testing/effect` also exports `foldEvents`, `Fold` and `Step`, so an Effect test imports nothing from `@demlik/tea/pbt`. `Fold` is new on `@demlik/tea/pbt` too, as the named return type of `foldEvents`.

**Additive (declaration only):** `foldEvents` on `@demlik/tea/pbt` now declares its return type as `Fold<S, M, C>`, the same four fields it returned before under no name. No existing call needs editing.
