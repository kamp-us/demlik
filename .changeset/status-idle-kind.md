---
"@demlik/tea": minor
---

`AgentStatus` on `@demlik/tea/agent` (experimental tier) gains an `idle` member, and `status(s)`
returns `{ kind: "idle" }` for a Model whose `run.phase === "idle"` — the slice straight out of
`init`, before any `agent_start`. Previously such a Model fell through to `running`, so a caller
deciding "start or resume" off `status` booted a run that had not begun, and a DO host reading a
hydrated-but-unstarted Model reported it live. A `stale` run still reads `running`; `failed`,
`done` and `suspended` are unchanged. An exhaustive `switch` over `status(s).kind` now needs an
`idle` arm.
