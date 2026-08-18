# lane:view — see a fabrika lane

```sh
pnpm lane:view                                     # three real lanes, bundled
LANE_DIR=~/phoenix/.fabrika/lanes pnpm lane:view   # your own
```

Opens a browser. That is the whole setup.

## What it reads

A lane is two files, and `fabrika` already writes both:

```
<lane>/workflow.json    the machine
<lane>/events.jsonl     what happened
```

Point `LANE_DIR` at ONE lane directory, or at the parent holding several — both
work, and several become tabs. A lane that has been emitted but never run has no
`events.jsonl` yet; that is fine, and shows every task where it booted.

`.fabrika/` is gitignored — a lane exists only on the machine that ran it — so
this reads the disk where you start it. Nothing uploads and nothing leaves.

## Who sends what

`workflow.json` records topology and never provenance, so the library ships no
cast: which events come from a human, from the operator, from the work the lane
dispatched. This viewer carries fabrika's (`origins.ts`), which is what turns
*"nothing is stuck"* into *"`blocked` moves only when a human sends
`UNBLOCKED`"*.

Drop an `origins.json` beside a lane to override it.

## Sending an event

The page never writes `events.jsonl`. `lane transition`'s own contract is
"record one operator event AFTER the machine accepts it, never before" — it
refuses an event the task's state has no cell for and leaves the log
byte-identical. A second writer would have to re-implement every one of those
refusals and would drift from them. So the button shells out to the CLI that
owns the ledger, and a refusal is an answer we display.

```sh
FABRIKA_BIN="node packages/fabrika-cli/src/bin.ts" \
FABRIKA_CWD=~/phoenix \
LANE_DIR=~/phoenix/.fabrika/lanes pnpm lane:view
```

`FABRIKA_CWD` matters: fabrika refuses to run when the copy you invoked and
your cwd are in different repositories, which is right and which the viewer
cannot paper over.

Only the events a task's own chart declares out of its current state are
offered. The rest would be refused anyway, and a button that exists to be
refused teaches nothing.

## Who is driving

Claims live on GitHub, not in the two files — `lane/claim.ts` is explicit that
"no claim state is derivable from a fold". So the viewer reads `lane-claim:`
markers off the issue with `gh`, cached for a minute.

Everything about it degrades: no `gh`, no auth, no network, or a chore lane
with no thread to race on, each answer **unknown** and render nothing. A lane
shown as free while someone holds it is the one wrong answer, because it is the
one that gets a second driver started.
