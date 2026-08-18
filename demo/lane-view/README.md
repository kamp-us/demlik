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
