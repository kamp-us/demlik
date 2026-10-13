---
"@demlik/tea": minor
---

`@demlik/tea/effect` exports its own `Cmd`. Its `Cmd.define` takes plain Effect schemas, so an Effect Schema user no longer wraps `input` and `ok` in `Schema.toStandardSchemaV1`:

```ts
import { Cmd } from "@demlik/tea/effect";
import { Schema } from "effect";

const fetchUser = Cmd.define("fetch_user", {
  input: Schema.Struct({ id: Schema.String }),
  ok: Schema.Struct({ name: Schema.String }),
  err: ["not_found"],
});
```

It returns the same Cmd the core `Cmd.define` returns, and `Cmd.none`, `Cmd.batch`, `Cmd.when` and `Cmd.whenDefined` are the core's. A schema whose two sides differ (a transformation such as `Schema.FiniteFromString`, or a brand) is a compile error, and so is one that needs a service. Pass `Schema.toType(schema)` to keep its checks. The entry also exports the `Cmd` type and `CheckingSchema`, the schema type `Cmd.define` accepts. The core `Cmd.define` does not change.
