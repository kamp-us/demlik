---
"@demlik/tea": minor
---

`@demlik/tea/agent` exports `agentTool`, which wraps a child `defineAgent` as a
tool a parent `defineAgent` calls and awaits. The child runs under its own Store
and `runId`, both keyed `<namespace>/<callId>` from the parent's call, so a
parent resumed after an eviction resumes its child rather than restarting it,
and a child that had already ended gives back the outcome it recorded. A child
that ends `failed` or `cancelled` settles the parent call as `child_failed` or
`child_cancelled`, which the parent model reads as the call's reason (#333).
