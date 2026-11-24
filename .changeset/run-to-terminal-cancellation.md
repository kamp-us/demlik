---
"@demlik/tea": minor
---

**Additive (declaration only):** `runToTerminal` (`@demlik/tea/flow`) now accepts `run`'s optional `cancellation: { signal, cancel }` in its seed. The type comes from `PromiseRunOptions`, so a host can stop the machine from outside without patching the declaration. The runtime already passed the field on to `run`. When the signal aborts, the run folds `cancel`'s Msg the same way `run` does, and `runToTerminal` resolves with the State that Msg lands. A seed without `cancellation` behaves as before.
