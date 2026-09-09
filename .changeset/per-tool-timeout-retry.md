---
"@demlik/tea": minor
---

`tool()` grows `timeoutMs` and `retry`, so a `defineAgent` user can bound or retry one
flaky tool without reaching down to `createAgent`.

Both run in the reducer, through the same `resilient-call` family the brain call already
uses, so the ladder is DATA on the durable Model rather than control flow inside the
handler: a waiting retry is a `waiting_retry` phase with its timer armed as a
subscription, and a process killed between two attempts resumes on the attempt it was on
instead of refilling the budget. That is the property the only previously reachable
recourse — a `Promise.race` or a `for` loop inside the handler — cannot have, because it
lives inside the effect boundary.

```ts
const fetchRate = tool(
  "fetch_rate",
  {
    description: "Fetch today's exchange rate",
    input: z.object({ pair: z.string() }),
    ok: z.object({ rate: z.number() }),
    err: ["upstream"],
    timeoutMs: 5_000,
    retry: { baseMs: 100, factor: 2, capMs: 5_000, jitter: "full", maxAttempts: 3 },
  },
  handler,
);
```

A spent budget settles as `{ kind: "error", reason: 'retry_exhausted {"attempts":3,"last":"upstream"}' }`
and an elapsed one as `{ kind: "error", reason: "timeout" }` — the same `ToolOutcome`
shape every other tool failure already has, so an adapter that renders one renders these.
Absorbed attempts never reach the conversation.

Additive on every surface. A tool that declares neither field mints no slice entry, arms
no timer, and behaves exactly as before. Two things are new beside the spec fields: the
`AgentState.toolResilience` slice (`{}` for an agent that uses no knob) and the
`AgentConfigCore.toolResilienceOf` seam a hand-wired `createAgent` fills, which
`toolRouter` now serves as `resilienceOf`.

`timeoutMs` is the whole call's budget, not one attempt's — measured from the first
attempt, and a retry does not restart it. It does not cancel the handler either: a promise
cannot be cancelled in JavaScript, so the call is over at the budget and the loop moves on
while the attempt runs to its own end, folding nothing when it settles late.
