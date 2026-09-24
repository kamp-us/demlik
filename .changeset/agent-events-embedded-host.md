---
"@demlik/tea": patch
---

`./agent`: `agentEvents` projects each transition's notes once for a host that
embeds the agent's verbs (#355).

- **No repeat events from a host's own Msgs.** A host that wires the verbs by
  hand and folds a Msg of its own left the previous agent transition's outbox
  standing, and `agentEvents` projected it again, so `traceAgent` opened
  duplicate spans. Each projector now projects an outbox once. The host's
  wiring does not change, and `toMachine` runs project exactly as before.
- **`agentTool` hands on only its tool fields.** The tool it builds never
  carries `content`, even from a spec object that has one at runtime.
