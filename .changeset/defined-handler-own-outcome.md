---
"@demlik/tea": patch
---

On the Promise engine, a `Cmd.define`d handler that `dispatch`es its own
`<name>_ok` or `<name>_err` Msg now has that Msg dropped, and an
`OutcomeContractError` goes to `onError`, as ADR 0021 requires: only the engine
mints a defined Cmd's outcome Msg. Any other Msg the handler dispatches is still
delivered, and hand-written Cmds are unaffected (#298).
