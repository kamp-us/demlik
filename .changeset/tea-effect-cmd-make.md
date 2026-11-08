---
"@demlik/tea": minor
---

**Breaking:** `Cmd.define` from `@demlik/tea/effect` is now `Cmd.make`. Replace Effect-entry calls with `Cmd.make(name, { input, ok, err })`. The old name is removed with no deprecated alias. Schema checks, inferred types and list helpers stay the same. The neutral core's `Cmd.define` and `defineCmd` are unchanged.
