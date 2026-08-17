# Inspect a chart live

**Goal.** Get a working debugger for a machine you authored with `./chart` — a
button per message, a live state panel, a diagram with the current node lit, and
a time-travel scrubber — without writing any of it.

You will use `@demlik/tea/chart/inspect/react` for the page and
`@demlik/tea/chart/inspect` for the headless core underneath it.

## Why there is nothing to configure

A hand-built debugger page for a machine types four things out by hand: the list
of messages, the state names, which control is disabled when, and what each
payload looks like. All four are already in the chart — that is what makes a
chart different from a `Transitions` table — so the inspector reads them instead
of asking you for them. A prop that restated one would be the same fact written
twice, which is the thing `./chart` exists to prevent.

## 1. Mount the component

```tsx
"use client";
import { ChartInspector } from "@demlik/tea/chart/inspect/react";
import "@demlik/tea/devtools/styles.css";
import "@demlik/tea/chart/inspect/styles.css";
import { assign, guards, lane } from "./lane";

export function LaneDebugger() {
  return (
    <ChartInspector
      chart={lane}
      parts={{ assign, guards }}
      boot={() => ({ retries: 0, maxRetries: 3 })}
      samples={{
        WIP: { at: 1 },
        DONE: { at: 2 },
        BLOCKED: { at: 3, reason: "review is backed up" },
        PASS: { at: 4 },
        FAIL: { at: 5, reason: "flaky" },
        UNBLOCKED: { at: 6 },
      }}
      title="lane"
    />
  );
}
```

That is the whole page.

Four props, and each is a fact the chart genuinely does not carry:

| Prop | Why it is not derivable |
| --- | --- |
| `parts` | The code the chart deliberately does not own — payload builders, guard bodies, cells. Same bag `compile` demands. |
| `boot` | The chart names the entry state (`initial: true`); it cannot know that `maxRetries` is 3. |
| `samples` | `ty<T>()` is `{}` at runtime, so a payload's shape is erased before any runtime code could read it. |
| `ctx` | The runtime environment. Omit it for a machine that reads nothing from one. |

`samples` is still typed **by the chart**: its keys are exactly the events that
declare a payload, each value is exactly that event's declared type, an event
with no payload has no key to write, and a typo'd name is an excess property.
Same use-site scanning idiom as `Assigns` and `Guards`.

## 2. Read a refusal

At `queued`, the `PASS` control is on screen and refused, reading

> `"PASS" is not addressed to phase "working" (scope: edges)`

That is the point of the panel. A chart is TOTAL over (state × event): a pair is
declared, or refused — by the event's `scope`, by the state's `ignore`, or by
`end: true` — and there is no third case. A debugger that hides all three behind
a missing button throws away the one thing this substrate knows. So a refused
event renders as **visibly refused, with the mechanism that refused it**.

## 3. Watch a guard decide

At `review`, the `FAIL` control reads `→ build [retriesRemaining]`. Edit its
payload box to `{"at":5,"reason":"fatal"}` and it becomes
`→ frozen [!retriesRemaining]` — the guard was executed against the live state
and that payload, and the branch it takes is what you see.

Guards are pure (the same things `replay` may call), so previewing costs nothing
and changes nothing. Where a guard cannot be evaluated — no sample, no bag, a
body that throws — the control says so (`retriesRemaining? (no-sample)`) rather
than guessing a branch.

## 4. Scrub

The slider runs over every recorded transition. Moving it re-folds that PREFIX of
the recorded messages through `replay` — `init` + `update` only, never
`interpret`, never a Store, never a live subscription. Scrubbing backwards
therefore re-derives history rather than re-performing it, so no effect fires
twice. `live` returns to the present; `reset` re-boots the machine.

## Without React

The whole useful half is headless and framework-free:

```ts
import { describeChart, inspectState } from "@demlik/tea/chart/inspect";

const desc = describeChart(lane);
desc.phases; // [{ name: "working", states: ["queued", …] }, …]
desc.refusals; // every refused (state, event) pair, with its reason

for (const v of inspectState(desc, state, { parts: { guards }, samples })) {
  console.log(
    v.event,
    v.status,
    v.status === "refused" ? v.why : v.guard?.branch ?? v.resolved,
  );
}
```

`describeChart` is pure and never executes a part, so it works on a chart whose
parts do not exist yet. Use it from a script, a test, or an Ink TUI.

## The diagram, on its own

`chartMermaid` takes an optional options bag:

```ts
chartMermaid(lane, {
  highlight: state.type, // light the active node
  phases: true, // draw phases as composite states
  direction: "LR",
  title: "lane",
});
```

Every default reproduces the drawing it emitted before options existed, so
adding one is opt-in.

## See also

- [Author a machine as config](./author-a-machine-as-config.md) — the chart the
  inspector reads.
- [Compose a battery inside a chart](./compose-a-battery-inside-a-chart.md) — a
  `{ to, cell }` edge; the inspector shows the whole declared fan-out and, when
  the cell can be run purely with samples, the target it actually picks.
- [Replay a recorded run in a test](./replay-in-a-test.md) — the same pure fold
  the scrubber uses, as an assertion.
