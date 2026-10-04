---
"@demlik/tea": patch
---

The agent docs now match the source: the agent layer is named as running on the
Promise engine, a `tool()` handler is shown taking only `args`, `ctx` and
`{ ok, fail }`, the six undeclared tool failures are in one table, and a `.with`
wrapper returns an outcome, not a Msg. No code changed.
