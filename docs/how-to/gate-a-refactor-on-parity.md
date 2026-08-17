# Gate a refactor on a parity check

To prove a rewritten engine still behaves like the one it replaces, record a run
off the old machine, re-fold that recording through the new one, and diff the two
final states after normalizing away record-time noise. `@demlik/tea/parity` is
thin packaging over three things you already have — `recorder` captures, `replay`
re-folds, `trace-replay`'s `deepEqual` compares — plus the one genuinely new
piece, `normalizeForParity`. What you get is a GO/NO-GO boolean per run.

## 1. Record the golden run

Attach `recordRun` to the synchronous `run()` handle, before `await runtime.ready`,
so the boot transition is captured as `loaded`. Drive the runtime as production
does, then snapshot with `trace()`:

```ts
import { run } from "@demlik/tea";
import { recordRun } from "@demlik/tea/parity";

const runtime = run(auditMachine, { ctx });
const rec = recordRun(runtime);

await runtime.ready;
for (const page of pages) await runtime.dispatch({ type: "scan", page });

const golden = rec.trace();
rec.stop();
await runtime.stop();
```

Non-determinism is a *record-time* property: the ids and timestamps an effect
minted during this run are frozen into `golden.msgs`. Replay never re-mints them,
so the same recording reproduces byte-identically forever.

## 2. Keep the recording as a fixture

`toJSONL()` serializes the recording; `parseJSONL` from `@demlik/tea/recorder`
hydrates it back into a `Trace`. Write it once from a real production run and the
gate no longer needs the old engine present at all:

```ts
import { parseJSONL } from "@demlik/tea/recorder";

await writeFile("fixtures/audit-golden.jsonl", rec.toJSONL());

// later, in the test:
const golden = parseJSONL<State, Msg>(
  await readFile("fixtures/audit-golden.jsonl", "utf8"),
);
```

## 3. Replay the same recording through both engines

`goldenReplay` folds `loaded` + `msgs` through `init` and `update` only — no
`interpret`, no `Store`, no subscription. It takes a live `Recording` handle or a
bare `Trace`, and `ctx` is the environment supplied fresh at replay time:

```ts
import { goldenReplay } from "@demlik/tea/parity";

const oldState = goldenReplay(auditMachine, golden, ctx);
const newState = goldenReplay(auditMachineV2, golden, ctx);
```

Both sides consume the *same* input sequence, so any difference in the two
states is a difference in the reducers — never in the world.

## 4. Normalize before you compare

Raw states differ on generated ids, timestamps, and intra-effect ordering — noise,
not behavior. `normalizeForParity` returns a pure `(value) => normalized` that
strips those keys, recursively sorts object keys, and stable-key-sorts arrays. The
defaults strip `id`, `runId`, `timestamp` and sort by `ruleId`, `selector`, `url`;
pass a `ParitySchema` when your domain names them differently:

```ts
import { type ParitySchema, normalizeForParity } from "@demlik/tea/parity";

const schema: ParitySchema = {
  stripKeys: ["id", "etag", "observedAt"],
  sortKeys: ["ruleId", "resourceId"],
};
const normalize = normalizeForParity(schema);
```

Build the normalizer once and apply it to both sides — it is a pure function, so
reusing it across runs costs nothing.

## 5. Take the verdict

`parityEqual` is the gate. It reuses `trace-replay`'s order-insensitive
`deepEqual` rather than adding a second comparator, so `true` means *behaviorally
equivalent under the schema*:

```ts
import { parityEqual } from "@demlik/tea/parity";

expect(parityEqual(normalize(oldState), normalize(newState))).toBe(true);
```

Use `parityEqual`, not the `diff` alias — `diff` is deprecated for its inverted
name (it returns `true` when the values are EQUAL, so `if (diff(old, new))` reads
backwards) and is removed after one minor.

## 6. Localize a failure to the step that drifted

A red gate tells you the run diverged, not where. Record with `captureSteps: true`
and the trace carries a `(msg, post-state)` pair per transition, so you can walk
prefixes until parity breaks and name the exact message:

```ts
const rec = recordRun(runtime, { captureSteps: true });

// after a failing gate:
for (const [k, step] of (golden.steps ?? []).entries()) {
  const prefix = {
    loaded: golden.loaded,
    msgs: golden.msgs.slice(0, k + 1),
    finalState: step.state,
  };
  if (!parityEqual(normalize(goldenReplay(machineV2, prefix, ctx)), normalize(step.state))) {
    throw new Error(`parity broke at msg ${k}: ${step.msg.type}`);
  }
}
```

That is the whole gate: one recording, two folds, one normalized boolean — and a
rewrite that cannot silently drop a finding. The capture and re-fold primitives
underneath are documented on their own terms in
[Replay a recorded run in a test](./replay-in-a-test.md), and a machine you intend
to record is usually one you have already made resumable — see
[Make a machine durable and crash-recoverable](./make-durable.md).
