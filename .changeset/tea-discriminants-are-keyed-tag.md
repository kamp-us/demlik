---
"@demlik/tea": minor
---

**Breaking:** the key that names a variant is `_tag`, where it was `type`. Every Msg, Cmd, Sub, State and semantic event carries `_tag`, and the core constraint is `{ _tag: string }`.

It is the key Effect uses, so a `Machine.make` whose `msg` is a `Schema.TaggedUnion` now compiles, and `Schema.TaggedStruct`, `Match.tag` and `Data.TaggedEnum` fit a tea Msg as they are.

```ts
// before
type Msg = { type: "inc" } | { type: "add"; by: number };
if (msg.type === "add") count += msg.by;

// after
type Msg = { _tag: "inc" } | { _tag: "add"; by: number };
if (msg._tag === "add") count += msg.by;
```

Rename the key where you write a Msg, a Cmd, a Sub or a State and where you read one. A cell of `update` keeps its name. A content part of an agent message (`{ type: "text", text }`) and a Jev question keep `type`.

There is no alias, nothing reads both keys, and nothing converts saved data. An event row an older release saved carries `type`, and the event-sourced store's default parser drops it. A saved Model is not rewritten: one with no discriminant inside loads as before, and one whose State or stored Msgs carry `type` no longer matches its machine. Start those runs fresh, or convert them in your own `store.migrate`.
