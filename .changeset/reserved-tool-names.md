---
"@demlik/tea": patch
---

`tool()` on `@demlik/tea/agent` (experimental tier) refuses a reserved name. A tool's name is the
prefix of its `<name>_ok` / `<name>_err` settle Msgs and its own interpret key, so a tool named
`agent_tool`, `resilient`, `compact`, `compact_run`, `tool_rejected` or `snapshot_write` used to
overwrite the agent's own reducer or interpret cell through `toMachine`'s last-wins spread — with
no error at construction, `run` or dispatch (#72).

- `ReservedToolName` — every protocol discriminant in `MsgType` and every prefix a `_ok` / `_err`
  / `_run` entry was minted from, plus the router's `tool_rejected` and the checkpoint cell
  `snapshot_write`. Derived from `MsgType`, so a new entry there reserves its name and its prefix
  with no second edit.
- `tool("compact", …)` is a compile error; a reserved name that reaches `tool()` as a widened
  `string` throws `tool: "compact" is reserved — it is an agent-owned Msg prefix`, the same
  declaration-bug refusal `toolRouter` gives a name declared twice.
- `isReservedToolName(name)` — the runtime guard, exported beside the type.
