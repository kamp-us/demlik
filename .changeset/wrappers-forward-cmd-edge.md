---
"@demlik/tea": patch
---

`withDeadline`, `withTelemetry` and `withResilience` no longer drop `machine.cmds`, so `run`'s
interpret edge parses a `Cmd.define`d handler's `_ok` value and stamps `at` on the wrapped machine
exactly as on the bare one (#66). A malformed result behind a wrap now becomes the minted `_err`
carrying `malformed_result` instead of reaching the reducer raw. `withResilience`'s
`$resilience:run` carrier settles the target's result through the same edge `run` uses, handed
over on ctx, so the parsed and stamped Msg is what lands as the call's `result`.
