---
"@demlik/tea": patch
---

Host authors can pass a `defineAgent({ tools: [...] }).machine(input)` result to `createAgentHost` without casts or explicit type arguments. The host now infers and preserves tool settle messages in its runtime handle while still requiring the agent protocol. Existing host type arguments keep their defaults; runtime behavior is unchanged.
