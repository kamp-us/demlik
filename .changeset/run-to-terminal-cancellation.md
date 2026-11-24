---
"@demlik/tea": minor
---

`runToTerminal`'s seed now accepts `run`'s `cancellation: { signal, cancel }`. A host can stop the machine from outside without patching the seed type. When the signal aborts, the run folds `cancel`'s Msg the same way `run` does, and `runToTerminal` resolves with the State that Msg lands.
