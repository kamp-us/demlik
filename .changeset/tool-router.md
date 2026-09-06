---
"@demlik/tea": minor
---

`tool()` + `toolRouter()` on `@demlik/tea/agent` (experimental tier). Declare a tool once and
derive what a consumer used to hand-write twice — the `toolOf` mapping and the interpret cell.

- `tool(name, { input, ok, err, needs }, handler)` — one colocated value built on `Cmd.define`
  (#44). The Cmd's input is the model's call `{ callId, args }` with `args` parsed against
  `input`; the handler returns `Result<Ok, E>` over the declared `_tag` union (an undeclared tag
  is a compile error) and reads the `needs` slice off its ctx, demanded at `run`. The cell
  settles through the minted `<name>_ok` / `<name>_err`: a thrown handler becomes `_err`
  (`{ _tag: "thrown", message }`, or the thrown `_tag` when it is a declared one), never a
  rejection; an `_ok` value the `ok` schema rejects becomes the kernel's `malformed_result`.
- `toolRouter([...tools])` — `toolOf` (total: an unknown name or args failing the schema ride a
  `tool_rejected` Cmd that settles as an error the model sees), the `interpret` table, the `defs`
  for `Machine.cmds`, and `outcomeOf` for reading a settled tool off its Msg.
- `createAgent(...).toMachine({ tools })` — merges the router's cells, folds its `<name>_ok` /
  `<name>_err` into the conversation, and takes the tool Cmds off the `toolInterpret`
  obligation. `agentEvents({ tools })` projects those settles to `ToolSettled`. Both are
  additive: with no router every existing config and `toolInterpret` compiles unchanged.
