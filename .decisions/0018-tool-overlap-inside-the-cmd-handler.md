---
id: 0018
title: runInterpret stays serial; tool overlap lives inside the tool Cmd handler
status: accepted
date: 2026-09-09
tags: []
---

# 0018 — runInterpret stays serial; tool overlap lives inside the tool Cmd handler

**Scope:** the ordering guarantee `runInterpret` (`src/run.ts`) gives every machine, and where
wall-clock parallelism for an agent's tool calls is allowed to live. Transcribes the founder
ruling on [#163](https://github.com/kamp-us/demlik/issues/163), recorded at
[`issuecomment-5598546621`](https://github.com/kamp-us/demlik/issues/163#issuecomment-5598546621).

**What this decides:** the kernel's interpret loop runs one transition's Cmds one at a time and
will never interleave them; real overlap between an agent's tool calls belongs inside the
tool-launch Cmd's own handler; and `toolConcurrency`'s documentation is narrowed to the dispatch
knob it actually is.

## Context

`AgentConfigCore.toolConcurrency` was documented as "Max tools in flight at once. Omit / `1` →
serial dispatch (the default)." Both halves of that line are wall-clock claims, and the kernel
honours neither above `1`. `runInterpret` is a bare `for (const cmd of cmds)` that `await`s each
handler before reaching the next Cmd, so two launch Cmds emitted by one transition cannot overlap
however high the fan-out's concurrency is set. What the knob does today is move calls from
`pending` to `running` in the fan-out slice of the durable Model: the ledger says parallel, the
clock says serial.

`runInterpret` is the interpret loop for *every* machine, not just the agent's, so anything that
makes it concurrent is a kernel behaviour change for consumers who never set `toolConcurrency`.
That is what made this a decision rather than a bug: three directions were coherent and they are
not interchangeable.

- **(a) Concurrent interpret** — overlap a transition's Cmds inside `runInterpret`. This is what
  the doc line promised. It costs the most: Msgs from settled Cmds would fold in *completion*
  order rather than emission order, so replaying one log no longer reproduces the same fold unless
  settle Msgs are re-serialized at the edge. First-error semantics and the `inFlightCmds` count
  both need re-specifying. Kernel-wide and opt-out-less.
- **(b) Narrow the documentation** — say plainly that the knob is a dispatch/ledger knob. One doc
  line, no behaviour change, and the knob keeps its real Model-shaped meaning.
- **(c) Fan out inside the Cmd, not across Cmds** — keep the kernel serial and let the tool-launch
  Cmd's handler run its calls concurrently within one handler, settling one Msg per call through
  the existing edge. Real wall-clock overlap for the agent layer; `runInterpret`'s
  one-Cmd-at-a-time ordering and every replay guarantee untouched.

## Decision

**Take (c), with (b) as its first commit. Reject (a) explicitly.**

1. **`runInterpret` never interleaves Cmd handlers.** One transition's Cmds are interpreted one at
   a time, each handler awaited before the next Cmd is reached, and this is a guarantee rather
   than an implementation detail. Settle Msgs the loop enqueues fold in **Cmd-emission order**, so
   a replayed log reproduces the same fold. That is invariant 2's serializability in
   [`.patterns/tea/patterns/01-invariants.md`](../.patterns/tea/patterns/01-invariants.md) —
   time-travel and durable replay are built on it — and it stays.

2. **Option (a) is rejected.** Trading the serial fold for a speedup nobody has asked for by name
   is not a trade this package makes. A future reader of `runInterpret` who is about to propose
   concurrent interpret should find this rejection here first.

3. **Wall-clock overlap for tools lives inside the tool-launch Cmd's handler** — fan-out within
   one Cmd, one settle Msg per tool, folded in emission order at the edge. The kernel is not the
   seam that grows; the agent's tool cell is.

4. **`toolConcurrency` is documented as what it is today: a dispatch knob.** It says how many of
   one turn's calls a transition *launches* — what the fan-out ledger, and a `store`'s record of
   it, reports as `running` rather than `pending`. It carries no wall-clock promise until (3) is
   built, and its doc line must not imply one. The lid's own docstring on
   `DefineAgentConfig.toolConcurrency` already said this; `AgentConfigCore`'s did not, and now
   does.

## Consequences

Consumers who never set `toolConcurrency` see no change, which is the point of refusing (a): the
kernel's ordering contract is one every machine in this package depends on, and it was never
`toolConcurrency`'s to spend.

A caller who raised the knob expecting a faster turn still gets no speedup, and now the type's own
docstring says so instead of promising otherwise. That honesty is the whole of the first commit;
it is not the whole of the ruling. Until (3) lands, `toolConcurrency` remains a knob whose value
is the durable ledger's accuracy, not the turn's latency.

Building (3) is a real design pass rather than a doc fix — the router's tool `interpret` currently
returns its `Settled` for the kernel to fold, and a fanning handler must instead settle one Msg
per call through the injected dispatch, which touches the resilience ladder's launch/settle
boundary, the `inFlightCmds` count, and run-idle detection. It is tracked as
[#179](https://github.com/kamp-us/demlik/issues/179) and is not this record's deliverable; this
record is the ruling, and the direction it fixes is what that lane builds against.
