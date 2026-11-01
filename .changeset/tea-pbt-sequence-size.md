---
"@demlik/tea": minor
---

`arbMsgSequence` (`@demlik/tea/pbt`) takes a `size` option and forwards it to `fc.array`. fast-check's default size caps a list at `2 * minLength + 10`, so `maxLength: 60` came out about 10 long and a machine's deep states were never reached. Pass `size: "max"` to draw up to `maxLength`. With no `size`, a seed draws the same lists as before.

**Breaking (declaration only):** the published signature of a `stable` name changed, so the API ratchet asks for this callout. The option is optional: no existing call needs editing and no existing seed draws anything new.
