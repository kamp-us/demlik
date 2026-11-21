---
"@demlik/tea": minor
---

**Additive (declaration only)**: `createAgentHost` takes the machine's own message union as an inferred type parameter. Host authors can pass a `defineAgent({ tools: [...] }).machine(input)` result to it without casts or explicit type arguments, and the runtime handle keeps the tools' settle messages. The parameter defaults to `AgentMachineMsg`, so existing host type arguments compile unchanged. Runtime behavior is unchanged.
