---
"@demlik/tea": minor
---

`@demlik/tea/jev` is open — one new subpath at `battery` tier, over three
modules:

| Module | What it is |
|---|---|
| `protocol` | TypeSafe Jev's wire contract as types plus two pure functions, `parseAnswers` and `classifyStatus`. No I/O. |
| `ask` | One Cmd over `resilient-call` that issues the call, with the HTTP caller injected as a `JevPort` and a pure `JevFallback` behind it. |
| `classify-batch` | A stream of items turned into Jev calls by wiring `batch-window`, `fan-out` and the TTL `cache` around `ask`. |

A Jev call is a map of questions you name, and an answer comes back under each
name. The point of typing it is that a `choice` question's `criteria` keys ARE
its answer's `choice` domain — write the rubric once and the narrowing is free
at the call site:

```ts
import { createJevAsk, jevQuestions } from "@demlik/tea/jev";

const questions = jevQuestions({
  category: {
    type: "choice",
    instructions: "Which budget line is this?",
    criteria: { groceries: "Supermarkets", dining: "Restaurants" },
  },
});
// answers.category.choice : "groceries" | "dining"
```

The door owns no API key: whoever builds the `JevPort` adapter owns the
`Authorization` header, and a scripted test fake satisfies the same type — which
is what makes a Jev-backed machine replayable.

`battery` means this may break in a minor, before and after 1.0, provided the
changelog for that minor says so. It is the honest tier here for a second
reason: the door speaks a third-party wire contract, and a break upstream is a
break here.

The door is a re-export file over `src/internal/jev/`; nothing moved and nothing
was renamed to open it. `docs/reference/jev.md` is generated with the rest, and
[Ask Jev a typed question](https://github.com/kamp-us/demlik/blob/main/docs/how-to/ask-jev-a-typed-question.md)
wires a small machine end to end.
