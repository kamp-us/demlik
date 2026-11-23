---
"@demlik/tea": minor
---

**Additive (declaration only):** `createAgent` and `defineAgent` (`@demlik/tea/agent`) take an optional `domain: { init, step }` whose pure `step` folds each settled turn, tool outcome, nudge and compaction (the `AgentDomainEvent` union) into a slice the Model keeps at `domain`, so every Store persists it, `replayTrace` replays it, `stopWhen` and `continueWhen` read it as `state.domain`, and a mid-run Model saved without it throws `MissingAgentDomainError`, while `createAgentHost` (`@demlik/tea/do`) and the agent's state types gain a `D` type parameter that defaults to `never`, under which the Model and the reducer are unchanged.
