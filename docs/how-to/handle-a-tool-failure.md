# Handle a tool failure

**Goal:** declare a failure a tool may name, fail with it from the handler, and
know exactly what the model reads on the next turn — including the three
failures you never declared.

Every sample below is quoted from
[`examples/agent-tool-failure.ts`](../../examples/agent-tool-failure.ts), which
runs in-process with a scripted model. Run it and you get the transcript at the
bottom of this page, verbatim.

## Declare the failure tags

`err` is a list of `_tag` **name string literals** — not schemas. This is the
first thing readers get wrong: `fail({ _tag: "not_found" })` looks like a value
built from a schema, but `err` never sees a `z.object`. Passing one is a type
error with no runtime meaning.

```ts
const lookup = tool(
  "lookup",
  {
    description: "Look up the hex code for a colour name",
    input: z.object({ key: z.string() }),
    ok: z.object({ hex: z.string() }),
    err: ["not_found"],
  },
  async ({ key }, _ctx, { ok, fail }) => {
    if (key === "boom") throw new Error("the table went away");
    const hex = TABLE[key];
    if (hex === undefined) return fail({ _tag: "not_found", key });
    return ok({ hex });
  },
);
```

The handler's third argument is the settle pair. `ok(value)` is parsed against
`ok`; `fail(error)` takes the tagged value itself — `_tag` must be one of the
literals in `err`, and every other field on the object rides along as **detail**.
Here that detail is `key`, so the model is told which key was missing rather than
just that something was.

## The three failures you did not declare

`err: []` does **not** mean the tool cannot fail. Three failures exist whatever
you declare, and a consumer meets all three in a first afternoon:

| Tag | Minted when | Detail it carries |
| --- | --- | --- |
| `thrown` | the handler throws anything that is not one of *its own* declared tags — a network error, a `TypeError`, a rejected promise | `message`, the described throw |
| `unknown_tool` | the model names a tool no `toolRouter` in this agent declares — a hallucinated name, or one from a stale prompt | `name`, the name it asked for |
| `malformed_args` | the model names a real tool, but its `args` fail that tool's `input` schema | `name`, plus `issues` — one `{ path, message }` per schema violation |

`"thrown"` is appended to **every** tool's `err` by `tool()` itself, so
`ToolDef`'s error type is always `TaggedError<…yours | "thrown">`. A throw whose
`_tag` *is* one of your declared tags is passed through as that tag; anything
else becomes `{ _tag: "thrown", message }`.

The other two are the router's, not any tool's. `toolOf` is total — it never
throws inside the reducer — so a call it cannot route rides its own Cmd and
settles like any other tool failure. Your reducer sees no special case.

## Bound a slow tool, or retry a flaky one

A tool that is *slow* or *intermittently down* is not a failure you can declare —
there is no tag for "the upstream is having a minute". Declare a budget and a
ladder on the spec instead, and the agent runs both for you:

```ts
const fetchRate = tool(
  "fetch_rate",
  {
    description: "Fetch today's exchange rate from the upstream service",
    input: z.object({ pair: z.string() }),
    ok: z.object({ rate: z.number() }),
    err: ["upstream"],
    // One call gets 50ms, first attempt to last — a retry does not restart it.
    timeoutMs: 50,
    // …and a failed attempt is retried twice more, 10ms apart.
    retry: { baseMs: 10, factor: 1, capMs: 10, jitter: "none", maxAttempts: 3 },
  },
  async ({ pair }, _ctx, { ok, fail }) => {
    /* … */
  },
);
```

Two more reasons join the table, and they read exactly like the others:

| Tag | Minted when | Detail it carries |
| --- | --- | --- |
| `timeout` | the call outlived `timeoutMs` | none — the tag is the whole reason |
| `retry_exhausted` | the `retry` budget is spent | `attempts`, and `last` — the final attempt's own reason |

**Why this is a spec field and not a `for` loop in your handler.** The ladder runs
in the reducer, so a waiting retry is a `waiting_retry` phase on the durable Model
with its timer armed as a subscription. Kill the process between two attempts and
the next run resumes on the attempt it was on. A loop inside the handler lives
inside the effect boundary, where a crash loses the whole ladder and the resumed
run starts the budget again — which is the durability this library exists to
provide, so the appliance should not ask you to trade it away for a retry.

Three things worth knowing before you reach for these:

- **`timeoutMs` is the whole call's budget, not one attempt's.** It is measured
  from the first attempt and a retry does not restart it, so a `timeoutMs` under
  your ladder's total backoff will end the call mid-ladder. That is the
  `resilient-call` deadline the brain call already uses, applied per tool call.
- **A timeout does not cancel your handler.** A promise cannot be cancelled in
  JavaScript. The *call* is over at the budget and the loop moves on; the attempt
  runs to its own end and its late settle folds nothing. If you need the work to
  actually stop, take an `AbortSignal` in the handler.
- **Absorbed attempts are invisible to the model.** A retried failure never
  reaches the conversation — only the final outcome does. The model is not shown
  a problem the ladder already dealt with.

Declare neither field and nothing changes: no slice entry is minted, no timer is
armed, and the first failure is the outcome exactly as above.

## What the model actually receives

A settled call reaches the next brain call as a `tool` message whose `outcome`
is a `ToolOutcome<R>`:

```ts
type ToolOutcome<R> =
  | { readonly kind: "ok"; readonly result: R }
  | { readonly kind: "error"; readonly reason: string };
```

That is the whole union. Discriminate on `kind`; there is no third arm and no
`.d.ts` to open.

The `reason` string is rendered by `toolErrorReason`: **the tag, then the
remaining fields as JSON when there are any, and the bare `_tag` when there are
none.**

```
not_found {"key":"green"}
```

So a `fail({ _tag: "gone" })` with no detail renders as exactly `gone`, and the
detail you put beside the tag survives the rendering intact — which is the point.
The model reads this next turn and is expected to recover from it.

**The tag is flattened into that string.** By the time a `ToolOutcome` reaches
your adapter there is no `_tag` field left to switch on; if you need to branch
per failure, branch inside your handler or parse the leading token of `reason`
yourself.

## The transcript

Running the example prints one line per settled call — the `outcome` half is
exactly what the adapter renders into the provider's `tool_result` block:

```
c1 lookup → {"kind":"ok","result":{"hex":"#2563eb"}}
c2 lookup → {"kind":"error","reason":"not_found {\"key\":\"green\"}"}
c3 lookup → {"kind":"error","reason":"thrown {\"message\":\"the table went away\"}"}
c4 lookyp → {"kind":"error","reason":"unknown_tool {\"name\":\"lookyp\"}"}
c5 lookup → {"kind":"error","reason":"malformed_args {\"name\":\"lookup\",\"issues\":[{\"path\":\"key\",\"message\":\"Invalid input: expected string, received number\"}]}"}
c6 fetch_rate → {"kind":"error","reason":"retry_exhausted {\"attempts\":3,\"last\":\"upstream\"}"}
c7 fetch_rate → {"kind":"error","reason":"timeout"}
done: Blue is #2563eb; everything else failed.
```

`c1` is the declared success. `c2` is the declared failure. `c3`, `c4` and `c5`
are the three nobody declared. `c6` ran the handler three times before the budget
ran out; `c7` ran it once and was over at 50ms while that attempt was still
sleeping out its 500ms. Note that all six failures are the same shape —
`{ kind: "error", reason }` — so an adapter that renders one renders all of them.

## Render it for your provider

The adapter decides how a failure reads to its model. The tutorial's Anthropic
adapter sends the whole outcome and flags it:

```ts
case "tool":
  return [
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: m.callId,
          content: JSON.stringify(m.outcome),
          is_error: m.outcome.kind !== "ok",
        },
      ],
    },
  ];
```

Sending `reason` alone is also fine — `is_error` already carries the polarity.
What you should not do is drop the failure, or replace it with a generic string:
the detail beside the tag is the only thing that lets the model fix its own call
instead of retrying the identical one.

## See also

- [Build a durable agent](../tutorial/build-a-durable-agent.md) — where `tool()`
  and the adapter are introduced.
- [`@demlik/tea/agent` reference](../reference/agent.md) — `tool`, `toolRouter`,
  `toolErrorReason`, `ToolOutcome`.
