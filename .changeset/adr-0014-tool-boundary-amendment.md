---
"@demlik/tea": patch
---

ADR 0014 gains an amendment recording the #115 ruling: a tool's declared failure tags now
reach user code as `{ _tag, …payload }` on `ToolOutcome` and through `defineAgent`'s
`onToolError`, not only the model as a rendered `reason`.
