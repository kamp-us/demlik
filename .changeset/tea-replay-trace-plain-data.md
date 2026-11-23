---
"@demlik/tea": minor
---

`replayTrace` (`@demlik/tea/persistence`) has a second overload for a recording read back from storage, a `Trace<unknown, { readonly _tag: string }>` whose states and Msgs are plain data and not typed as the machine's. It folds and compares them as before, and the result's states and Msgs are `unknown`. A typed `Trace<S, M>` still resolves to the first overload and its typed result.

**Additive (declaration only):** `replayTrace` gains an overload; the first overload is unchanged.
