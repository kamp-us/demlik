# demo/lane-view — the page itself, under a dev server

**Looking at your lanes? You want `pnpm lane:watch`, not this.** That runs the
real host — the same one a consumer writes — against `.fabrika/lanes`, with
dispatch wired to the CLI that owns the ledger. Nothing to configure.

This directory is where the page is **built and worked on**. `pnpm lane:view`
runs it under vite with lanes read off disk at build time and updates riding
vite's own socket, which is what makes editing `main.tsx` a live-reload loop
instead of a rebuild. `build-viewer.mjs` then bundles this into the prebuilt
page `serveLaneViewer` serves, so what ships is what is developed here.

```sh
pnpm lane:view                                     # bundled lanes
LANE_DIR=~/phoenix/.fabrika/lanes pnpm lane:view   # your own, while editing
```

## What a lane is

Two files, and `fabrika` already writes both:

```
<lane>/workflow.json    the machine
<lane>/events.jsonl     what happened
```

`LANE_DIR` takes one lane directory or the parent holding several. A lane that
has been emitted but never run has no `events.jsonl` yet; that is fine and
shows every task where it booted.

`.fabrika/` is gitignored — a lane exists only on the machine that ran it — so
this reads the disk where you start it. Nothing uploads and nothing leaves.

## Who sends what

`workflow.json` records topology and never provenance, so the library ships no
cast: which events come from a human, from the operator, from the work the lane
dispatched. This page carries fabrika's (`origins.ts`), which is what turns
*"nothing is stuck"* into *"`blocked` moves only when a human sends
`UNBLOCKED`"*. Drop an `origins.json` beside a lane to override it.

A consumer passes the same thing as `origins` to `serveLaneViewer` — see
[`scripts/lane-watch.ts`](../../scripts/lane-watch.ts),
which is the host `lane:watch` runs.

## Sending an event

The page never writes `events.jsonl`. `lane transition`'s own contract is
"record one operator event AFTER the machine accepts it, never before" — it
refuses an event the task's state has no cell for and leaves the log
byte-identical. A second writer would have to re-implement every one of those
refusals and would drift from them. So the button asks the CLI that owns the
ledger, and a refusal is an answer we display in its words.

Only the events a task's own chart declares out of its current state are
offered. The rest would be refused anyway, and a button that exists to be
refused teaches nothing.

Under `lane:view` the dispatch target is set by env, because this harness is
not running inside the repo whose lanes you are reading:

```sh
FABRIKA_BIN="node packages/fabrika-cli/src/bin.ts" \
FABRIKA_CWD=~/phoenix \
LANE_DIR=~/phoenix/.fabrika/lanes pnpm lane:view
```

`FABRIKA_CWD` matters: fabrika refuses to run when the copy you invoked and
your cwd are in different repositories, which is right and which the page
cannot paper over. `lane:watch` needs none of this — it runs in the repo whose
lanes it reads.

## Who is driving

Claims live on GitHub, not in the two files — `lane/claim.ts` is explicit that
"no claim state is derivable from a fold". So the page reads `lane-claim:`
markers off the issue with `gh`, cached for a minute.

Everything about it degrades: no `gh`, no auth, no network, or a chore lane
with no thread to race on, each answer **unknown** and renders nothing. A lane
shown as free while someone holds it is the one wrong answer, because it is the
one that gets a second driver started.
