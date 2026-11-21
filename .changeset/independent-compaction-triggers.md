---
"@demlik/tea": minor
---

**Additive (declaration only)**: Add independent `defineAgent` compaction options
`afterInputTokens`, `afterImageBytes`, and `afterImageCount`. Each works alone;
configured thresholds use OR and request one fold when any fires. Input tokens
and image bytes use strict greater-than comparisons; image count uses at-least.
Preserve `afterContextTokens` as the last brain turn's reported input plus output,
including its at-least comparison, and preserve turn and retained-tail behavior.
