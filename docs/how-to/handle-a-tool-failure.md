# Handle a tool failure

**Goal:** declare a failure a tool may name, fail with it from the handler,
know exactly what the model reads on the next turn — including the three
failures you never declared — and branch on the tag in your own code.

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
  | { readonly kind: "error"; readonly reason: string; readonly _tag?: string };
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

**The tag rides beside that string, it is not replaced by it.** The `{ _tag,
…payload }` you failed with is spread onto the outcome, so the failure the model
reads as prose is the same failure your code reads as data:

```json
{"_tag":"not_found","key":"green","reason":"not_found {\"key\":\"green\"}","kind":"error"}
```

`kind` and `reason` are written last, so a payload field of either name can
never shadow the discriminant or the model's channel.

Why `_tag` is *optional* in the union above: a run persisted by 0.12.x or
earlier was written before the tag was kept, so a `Store` can hand back a
failure that has none. For the exhaustive per-tag type — where an unhandled
failure is a compile error — take `onToolError` below, which is typed from the
tools themselves.

## The transcript

Running the example prints one line per settled call — the `outcome` half is
exactly what the adapter renders into the provider's `tool_result` block:

```
hook: lookup missed the key green
c1 lookup → {"kind":"ok","result":{"hex":"#2563eb"}}
c2 lookup → {"_tag":"not_found","key":"green","reason":"not_found {\\"key\\":\\"green\\"}","kind":"error"}
hook: lookup failed with thrown
c3 lookup → {"_tag":"thrown","message":"the table went away","reason":"thrown {\\"message\\":\\"the table went away\\"}","kind":"error"}
hook: no tool called lookyp
c4 lookyp → {"_tag":"unknown_tool","name":"lookyp","reason":"unknown_tool {\\"name\\":\\"lookyp\\"}","kind":"error"}
hook: lookup failed with malformed_args
c5 lookup → {"_tag":"malformed_args","name":"lookup",…,"kind":"error"}
hook: fetch_rate failed with retry_exhausted
c6 fetch_rate → {"_tag":"retry_exhausted","attempts":3,"last":"upstream","reason":"retry_exhausted {\\"attempts\\":3,\\"last\\":\\"upstream\\"}","kind":"error"}
c7 fetch_rate → {"_tag":"timeout","reason":"timeout","kind":"error"}
hook: fetch_rate failed with timeout
done: Blue is #2563eb; everything else failed.
```

`c1` is the declared success. `c2` is the declared failure. `c3`, `c4` and `c5`
are the three nobody declared. `c6` ran the handler three times before its retry
budget ran out; `c7` ran it once and was over at 50ms while that attempt was
still sleeping out its 500ms. Note that all six failures are the same shape —
`{ kind: "error", _tag, …payload, reason }` — so an adapter that renders one
renders all of them. The `hook:` lines are `onToolError`, below.

## Branch on the failure in your own code

The model gets `reason`. Your program gets the tag, through `onToolError`:

```ts
const agent = defineAgent({
  model,
  tools: [lookup],
  instructions: "You look colours up.",
  onToolError: (outcome, { name }) => {
    switch (outcome._tag) {
      case "not_found":
        return console.log(`hook: ${name} missed the key ${outcome.key}`);
      case "unknown_tool":
        return console.log(`hook: no tool called ${name}`);
      default:
        return console.log(`hook: ${name} failed with ${outcome._tag}`);
    }
  },
});
```

`outcome` is typed from **this agent's tools**, so the `switch` narrows the
payload per tag — `outcome.key` above exists only in the `not_found` arm — and
the tags it must cover are every failure the run can produce: each tool's
declared tags, `thrown`, the kernel's `malformed_result`, the router's
`unknown_tool` / `malformed_args`, and the ladder's `timeout` /
`retry_exhausted` — the two a `tool()` spec's `timeoutMs` / `retry` can end a
call with from outside the handler. Handle them all and the default arm is
`never`; miss one and it is a compile error rather than a failure you find in a
log.

`ctx.name` is the tool the **model** asked for, which for an `unknown_tool` is
the name it invented — there is no declared tool to name there.

Four things worth knowing before you put anything real in it:

- **It fires once per failed call** — including a call that climbed a retry
  ladder, whose absorbed attempts the model is not shown and neither are you.
  *When* it fires depends on whether the tool declared `timeoutMs` or `retry`.
  A tool that declared neither is announced at the interpret boundary: after
  the handler settled, before the failure is folded into the conversation. A
  tool that declared either is announced off the fold instead, because its
  ending is minted by the reducer rather than by a handler — a timeout has no
  handler settle at all, since the call is over while its attempt is still
  running. That is why `c7`'s `hook:` line above prints after its record and
  the un-laddered ones print before theirs.
- **It is awaited.** An async hook holds that settle until it resolves, so keep
  it short and put anything slow on your own queue.
- **A resume does not replay it.** An outcome a previous process already folded
  is in the Model the `Store` handed back and is never re-interpreted, so a
  durable run does not re-fire the hook over its own history.
- **A throw is contained**, exactly as `onEvent`'s is: it is warned about and
  the run goes on. The hook cannot fail the run.

It observes; it does not decide. The model still reads `reason` next turn either
way — the hook cannot suppress a failure, retry it, or rewrite what the model is
told. Use it to log, to count, to page.

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
  `toolErrorReason`, `ToolOutcome`, `ToolError`, `defineAgent`.
