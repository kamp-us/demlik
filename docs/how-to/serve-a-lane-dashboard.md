# Serve a lane dashboard

You have lanes on disk — a `workflow.json` and an `events.jsonl` per lane — and
you want a screen that shows which of them needs a person. You do not want to
run a bundler to get it.

`@demlik/tea/chart/lane/server` ships the page prebuilt and asks you for the
three facts only you know.

## The whole adapter

```ts
import { createServer } from "node:http";
import { laneViewer } from "@demlik/tea/chart/lane/server";

const handle = laneViewer({
  // WHERE THE LANES ARE — you already read these.
  lanes: () => readMyLanes(),          // → { id, workflow, events }[]

  // HOW AN EVENT IS RECORDED — your verb, and the only writer.
  transition: async ({ lane, event, task }) => {
    const out = await myTransitionVerb(lane, event, task);
    return { ok: out.accepted, message: out.reason };
  },

  source: ".fabrika/lanes",
});
```

Mount it under any server that speaks `Request`/`Response`. A complete Node
host, including the streaming needed to keep `/api/stream` open, is in
[`examples/lane-dashboard/serve.ts`](../../examples/lane-dashboard/serve.ts).

## What the page does with that

Everything else is the library's, and it is the same code the tests cover:
folding the log, working out which task is stuck and *why*, ordering the fleet
by what needs a human, drawing each machine with the path it walked, and letting
a reader scrub back through the history.

## The four endpoints

| endpoint | answers | comes from |
|---|---|---|
| `GET /api/lanes` | every lane's two files | your `lanes()` |
| `GET /api/stream` | pushes when they change | `lanes()`, re-asked; see below |
| `GET /api/drivers` | who holds each lane | your `drivers()`, optional |
| `POST /api/transition` | records one event | your `transition()`, optional |

**Liveness is ours, not yours.** You could watch your own files and push, and
then every host would write that code and get it subtly different. The stream
re-asks `lanes()` on a timer, compares the answer, and only sends a change.
`pollMs` tunes it; the default is two seconds and a quiet fleet costs a couple
of file reads per tick.

## Who sends what

A workflow document records topology and never provenance, so nothing in the
files says whether `UNBLOCKED` comes from a human or a machine. Put it on each
lane as `origins` and the page can say *"`blocked` moves only when a human sends
`UNBLOCKED`"* instead of *"nothing is stuck"*:

```ts
origins: {
  from: {
    WIP: { world: "the operator" },
    UNBLOCKED: { world: "a human" },
    DONE: "cmd", PASS: "cmd", FAIL: "cmd",
  },
}
```

## Two modes worth knowing

**Read-only.** Omit `transition` and every lane still renders; nothing offers to
act. That is the right shape for a finished run.

**Ownership unknown.** Omit `drivers`, or let it throw, and the page says nothing
about who is driving. It never says "free" — a lane shown free while someone
holds it is the answer that gets a second driver started on one piece of work.
