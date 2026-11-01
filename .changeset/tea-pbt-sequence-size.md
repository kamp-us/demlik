---
"@demlik/tea": minor
---

`arbMsgSequence` (`@demlik/tea/pbt`) takes a `size` option and forwards it to `fc.array`. fast-check's default size caps a list at `2 * minLength + 10`, so `maxLength: 60` came out about 10 long and a machine's deep states were never reached. Pass `size: "max"` to draw up to `maxLength`. With no `size`, a seed draws the same lists as before.

**Additive (declaration only):** the option is optional, so an ordinary call needs no editing and no existing seed draws anything new. A variable passed as the options that already holds a `size` of another type stops compiling.
