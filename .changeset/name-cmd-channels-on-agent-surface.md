---
"@demlik/tea": patch
---

The `/agent` surface now names `Cmd<T, E, R>`, so a reader told the kernel has typed effect
channels (ADR 0014) can find them where they are actually spelled. No behaviour changes.

`tool()`'s docblock says it returns a `Cmd<T, E, R>` definition whose `T` is what `ok` parses and
whose `E` is the `err` tag union — in its first sentence, which is the part `docs/reference` is
generated from, so the reference row carries it too. The tutorial's "Declare a tool" section makes
the same read on the tool it just declared, including what the empty `err: []` means, and
`docs/explanation/errors-as-data.md` links back to it while naming the effect type once.
