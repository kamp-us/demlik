/**
 * @packageDocumentation
 * The transcript collector — the built-in way to KEEP a run's turns, given that
 * a finished run's Model does not.
 *
 * A run that reaches `phase: "done"` clears `conversation` to `null` on
 * purpose: the terminating turn is stamped onto `output` first, so the answer
 * survives, and the history that would otherwise grow without bound in storage
 * kept for its state is dropped (`docs/explanation/durability-model.md`). That
 * policy is not what this module changes. What it changes is that every
 * consumer wanting the history had to hand-write the same fold over `onEvent`.
 *
 * So this is a COLLECTOR over the event stream that already exists, not a knob
 * on the Model. Nothing here is durable, nothing here is written to a `Store`,
 * and a run with a collector attached is byte for byte the run it was without
 * one — the same reason `onChunk` rides a side channel rather than state.
 *
 *   const t = transcript<ToolResult<typeof tools>>();
 *   const final = await agent.run(input, { store, onEvent: t.onEvent });
 *   t.read().turns; // every turn this process settled
 *
 * ## What a resume needs from you
 *
 * Events are projected off the transitions THIS process applies, so a run
 * resumed from a `Store` re-emits nothing the killed process already settled.
 * A collector that only ever listened would therefore hold the tail of a
 * resumed run and call it the whole thing. Hence the seed: hand
 * {@link transcript} the Model the `Store` handed back and it starts from that
 * Model's live conversation, so the resumed collector reads as the whole run
 * rather than its last leg.
 */

import type { AgentEvent } from "./machine";
import type { AgentEndedStatus, AgentTurn, Conversation } from "./types";

/**
 * One tool call the run settled OK, as the transcript keeps it — the `callId`
 * and the result, which is exactly what the `ToolSettled` event carries.
 *
 * A tool that FAILED is absent, and that is the event stream's shape rather
 * than a choice made here: `ToolSettled` is projected off the OK settle alone.
 * Branch on failures through `onToolError`, whose argument is typed per tag.
 */
export interface TranscriptToolResult<R> {
  readonly callId: string;
  readonly result: R;
}

/**
 * Whether the run has ended, and how: `running` until `RunDone`, then the
 * ending it carried — `done` with the terminal turn, `failed` with the
 * failure, or `cancelled`.
 *
 * `done` keeps `output` inside its own arm because `output` is legitimately
 * `null` on a finished run, and a single nullable field would make "not
 * finished yet" and "finished with nothing" the same reading.
 */
export type TranscriptOutcome = { readonly kind: "running" } | AgentEndedStatus;

/** What a collector holds right now — a plain, immutable read. */
export interface TranscriptSnapshot<R> {
  /** Every model turn the transcript holds, in order. */
  readonly turns: readonly AgentTurn[];
  /** Every tool call that settled OK, in settle order. */
  readonly tools: readonly TranscriptToolResult<R>[];
  /** Whether `RunDone` has been seen, and how the run ended if so. */
  readonly outcome: TranscriptOutcome;
}

/**
 * The Model a resumed collector starts from — structural on purpose, so any
 * agent state (`DefinedAgentState<T>`, `AgentState<…>`) satisfies it without
 * this module importing the lid, and a bare `{ conversation }` object works in
 * a test.
 */
export interface TranscriptSeed<R> {
  readonly conversation: Conversation<R> | null;
}

/**
 * A live transcript: the listener you wire, and the read you take off it.
 *
 * `onEvent` is a bound function, so `{ onEvent: t.onEvent }` is the whole
 * wiring — there is no `this` to lose.
 */
export interface Transcript<R> {
  /** Wire this to `run`'s `onEvent`. */
  readonly onEvent: (event: AgentEvent<R>) => void;
  /** The transcript as of now. Each call returns a fresh immutable snapshot. */
  readonly read: () => TranscriptSnapshot<R>;
}

/**
 * Open a transcript collector over an agent run's event stream.
 *
 * Wire `onEvent` to `run`'s `onEvent` option and `read()` gives you the turns
 * and settled tool results afterwards — the transcript the finished Model no
 * longer carries.
 *
 * Pass `seed` when the run is a RESUME: the Model the `Store` handed back still
 * holds the live conversation the killed process built, and seeding from it is
 * what makes the collector hold the whole run rather than the leg this process
 * ran. One collector per process is the honest unit; a fresh run needs no seed.
 *
 * A seed taken from an already-finished Model contributes nothing, and
 * correctly so: that Model's `conversation` is `null` and its answer is its
 * `output`, which you already hold.
 */
export function transcript<R>(seed?: TranscriptSeed<R>): Transcript<R> {
  const turns: AgentTurn[] = [...(seed?.conversation?.turns ?? [])];
  const tools: TranscriptToolResult<R>[] = (
    seed?.conversation?.toolRecords ?? []
  ).flatMap((record) =>
    record.outcome.kind === "ok"
      ? [{ callId: record.call.callId, result: record.outcome.result }]
      : [],
  );
  let outcome: TranscriptOutcome = { kind: "running" };

  return {
    onEvent: (event) => {
      switch (event.type) {
        case "TurnSettled":
          turns.push(event.turn);
          return;
        case "ToolSettled":
          tools.push({ callId: event.callId, result: event.result });
          return;
        case "RunDone":
          outcome = event.status;
          return;
        // The started and failed events add nothing a transcript keeps: a
        // turn is kept once it settles, and a failed call is `onToolError`'s.
        case "BrainStarted":
        case "ToolStarted":
        case "ToolFailed":
          return;
      }
    },
    read: () => ({ turns: [...turns], tools: [...tools], outcome }),
  };
}
