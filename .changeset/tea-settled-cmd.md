---
"@demlik/tea": minor
---

**Additive (declaration only):** `Cmd.define`, `runCmdDef` and `createResilientCall` accept a pure `settledCmd` projection that minted `_ok` and `_err` Msgs carry in place of the issued Cmd, and `createLlmCall` uses it to settle model calls with `input.payload` set to `null` while handlers, retries and later-answer checks still see the full prompt.
