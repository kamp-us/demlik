/**
 * @packageDocumentation
 * @demlik/tea/chart/lane/react — a lane, as one page. **Experimental.**
 *
 * ```tsx
 * // the fabrika case: a workflow document and the log it produced
 * <LaneView lane={chartFromWorkflow(document)} log={parseEventsJsonl(jsonl)} />
 *
 * // the same page over a lane that is actually running
 * <LiveLaneView lane={epic} hands={hands} samples={samples} />
 * ```
 *
 * WHY THIS EXISTS. `<ChartInspector>` takes a LIVE MACHINE — a chart plus the
 * code bodies — and runs it. A real fabrika lane is the opposite shape:
 * already-run history, no code bodies anywhere, imported at runtime from a
 * `workflow.json`. So until this component, the one thing a real consumer most
 * wants to look at could only be looked at as markdown. One core serves every
 * surface, and a lane could reach only one of them.
 *
 * TWO SOURCES, ONE PRESENTATION. Both components render the SAME panels from
 * the same model (`laneView` in `./view`), and neither of them branches on
 * which source it has. What the source decides is what is OFFERED, and an
 * unavailable control is drawn as unavailable WITH THE REASON — never silently
 * absent, which is the same rule the refusal rendering has always followed:
 *
 *   REPLAY — every control says "this lane is a workflow document and its event
 *   log; the code bodies that would run an edge do not exist here". The lane
 *   moves by its log and by nothing else, and the scrubber runs over that log.
 *
 *   LIVE — the controls dispatch. A legal event sends `${task}.${event}`, the
 *   addressed form `compile(chart, parts, taskId)` already keys the table by.
 *   A refused one is still on screen, refused by the CHART rather than by the
 *   source, and saying which mechanism refused it.
 *
 * The same discipline covers the two questions one source cannot answer at all:
 * a live tape carries the ORDER of its msgs and no wall-clock, so the timeline's
 * "at" column is an `Unanswerable<"clock">` with the reason rather than a column
 * of invented times; and a region whose state keeps no `retries` gets an
 * `Unanswerable<"retries">` rather than a confident `0/2`.
 *
 * WHICH OF TWELVE THINGS IS STUCK — first, because for a real epic that is the
 * first question, and a page that answers it fourth is a page that answers it
 * too late. The panel is `inspectLane`'s own `stuck` list, with the phase
 * attached so the answer names a place as well as a task.
 *
 * THE WALL OF DIAGRAMS, AND WHY THERE ISN'T ONE. `report.ts` learned from a real
 * emitted epic that a phase holds eight tasks and six of them sit untouched at
 * their entry state, and that drawing all eight produces a wall nobody reads.
 * That judgement is not relearned here: only the ACTIVE phase expands, and
 * inside it only the tasks that have MOVED (plus, in a TRIPPED phase, the tasks
 * that tripped it — on the screen someone opened about a stopped lane, that task
 * is the whole reason they are here). The one concession the medium earns is
 * that a collapsed task keeps its entire panel — waiting-on, controls, picture —
 * behind a disclosure instead of losing it. The reader who wants the seventh
 * diagram can have it, the reader who wants the answer is not made to scroll
 * past six, and on a LIVE lane a collapsed region is still dispatchable one
 * click of the triangle away.
 *
 * NO NEW DEPENDENCY. The diagram is emitted as `<pre class="mermaid">` for a
 * host renderer, exactly as `<ChartInspector>` does — the text is readable with
 * no renderer at all. Styling follows the same contract: one stylesheet, every
 * class prefixed (`tea-lv-*`), wired to the consumer's design tokens. Import
 * `@demlik/tea/chart/lane/styles.css`.
 */

"use client";

import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { type Cmd, type Machine, replay, type Sub } from "../../index";
import type { Recorder, Trace } from "../../recorder";
import type { Samples, Unanswerable } from "../inspect";
import { useInspectorRuntime } from "../inspect/react";
import type { LogEntry } from "../report/fold";
import type { ImportedLane } from "../report/workflow";
import {
  type LaneHandsOf,
  type LaneRunMsg,
  type LaneRunState,
  runLane,
} from "./run";
import type { LaneTaskChart, LaneTaskId } from "./structure";
import {
  type LaneControl,
  type LaneFeed,
  type LanePhaseView,
  type LaneTaskView,
  type LaneViewModel,
  laneView,
  liveFeed,
  type RunningLeaf,
  replayFeed,
} from "./view";

// ── props ─────────────────────────────────────────────────────────────────

/**
 * Everything `<LaneView>` needs, and it is the two files a fabrika lane IS.
 *
 * There is no prop for the phases, the tasks, the states, the standings, the
 * terminal or what anything is waiting on: every one of those is derived from
 * these two, and a prop restating one would be the fact said twice.
 */
export interface LaneViewProps {
  /** The lane. `chartFromWorkflow(document)` or `defineLane(spec)` — either door. */
  readonly lane: ImportedLane;
  /** Its event log — `parseEventsJsonl(...)` or `parseHistoryJson(...)`. */
  readonly log: readonly LogEntry[];
  /** Heading. Cosmetic — defaults to the document's own `id`. */
  readonly title?: string;
  /** Appended to the container's class list. */
  readonly className?: string;
}

/**
 * One sample bag per task, each typed by THAT task's chart.
 *
 * The one thing a lane genuinely cannot derive, and the only reason it is a
 * prop: `ty<T>()` is `{}` at runtime, so a payload's shape is erased before any
 * runtime code could read it. Optional per task, because a task whose events
 * declare no payload has nothing to supply.
 *
 * WHAT A LANE LOSES, said here rather than found out. `defineLane` LOWERS its
 * charts to the runtime-typed form the fold and the drawing share, and that form
 * records which events a state routes and NOT which of them declare a payload.
 * So no control is ever reported as blocked for want of a sample: a msg is built
 * either way, with the sample merged in when one was given. Supply one where a
 * guard reads a payload field, and the guard preview reads the field you meant.
 */
export type LaneSamples<L> = {
  readonly [T in LaneTaskId<L>]?: Samples<LaneTaskChart<L, T>>;
};

/**
 * Everything `<LiveLaneView>` needs — the lane, and the hands `runLane` demands.
 *
 * `hands` is not a restatement of the lane: it is the code the lane deliberately
 * does not own (each region's `parts`, and where each instance BOOTS, which an
 * emitted epic decides per sub-issue). It is the same bag `runLane` takes, so
 * an author passes the one they already built.
 */
export interface LiveLaneViewProps<L, H, Ctx> {
  readonly lane: L;
  /** The parts and boot state per task — the same bag `runLane` demands. */
  readonly hands: H;
  /** One payload sample per event that declares one, per task. */
  readonly samples?: LaneSamples<L>;
  /** The runtime ctx. Omit for a lane whose regions read nothing from one. */
  readonly ctx?: Ctx;
  readonly title?: string;
  readonly className?: string;
}

// ── the components ────────────────────────────────────────────────────────

/**
 * A lane that has already run, looked at: the REPLAY source.
 *
 * The scrubber folds a prefix of the real log, which is not an approximation of
 * the state at step k but the definition of it (`fold.ts`), so dragging it
 * backwards shows exactly what the driver would have printed at that moment.
 * Nothing is dispatchable and every control says why.
 */
export function LaneView(props: LaneViewProps) {
  const feed = useMemo(
    () => replayFeed(props.lane, props.log),
    [props.lane, props.log],
  );
  return (
    <LanePanels
      feed={feed}
      title={props.title}
      className={props.className}
      send={null}
    />
  );
}

/**
 * The same page over a lane that is RUNNING — the LIVE source.
 *
 * It owns a runtime for its lifetime (`runLane`'s `init`/`update`, built into a
 * `Machine` here rather than asked for, so the drawing and the runtime provably
 * come from the same lane) and records it, so the scrubber time-travels by the
 * same pure `replay` `<ChartInspector>`'s does: `init` + `update` only, never
 * `interpret`, so dragging backwards cannot re-fire an effect.
 */
export function LiveLaneView<
  L extends ImportedLane,
  const H extends LaneHandsOf<L, H>,
  Ctx = Record<never, never>,
>(props: LiveLaneViewProps<L, H, Ctx>) {
  const { lane, hands, ctx } = props;
  const [epoch, reset] = useReducer((n: number) => n + 1, 0);

  const machine = useMemo(
    () =>
      // The one cast, at the construction boundary — `runLane` returns exactly
      // the `init` and `update` a `Machine` is made of, over the lane's own
      // derivations, and `Machine` wants them under the caller's names.
      ({ ...runLane(lane as never, hands as never) }) as unknown as Machine<
        LaneRunState<L>,
        LaneRunMsg<L> & { readonly type: string },
        Cmd,
        Sub<never>,
        Ctx
      >,
    [lane, hands],
  );
  const { rt, rec } = useInspectorRuntime(machine, ctx as Ctx, epoch);

  if (rt === null) {
    return (
      <div className={containerClass(props.className)}>
        <div className="tea-lv-boot">booting…</div>
      </div>
    );
  }
  return (
    <LiveLanePanels
      key={epoch}
      lane={lane as unknown as ImportedLane}
      hands={hands as unknown as Readonly<Record<string, { parts?: object }>>}
      samples={props.samples as unknown as RtLaneSamples | undefined}
      machine={machine}
      runtime={rt}
      rec={rec}
      ctx={ctx as Ctx}
      title={props.title}
      className={props.className}
      onReset={reset}
    />
  );
}

/** The samples bag, after the type layer has done its work. */
type RtLaneSamples = Readonly<
  Record<string, Readonly<Record<string, object>> | undefined>
>;

/**
 * The live half's body: subscribe, record, and turn the recorded tape into the
 * same {@link LaneFeed} the replay source produces.
 *
 * Split out from `<LiveLaneView>` so the hooks below run only once a runtime
 * exists — the same shape `<ChartInspector>`/`<InspectorView>` uses, and for the
 * same reason: until `ready` resolves there is no total `getState` and nothing
 * honest to render.
 */
function LiveLanePanels<S, M extends { type: string }, K extends Cmd, Ctx>({
  lane,
  hands,
  samples,
  machine,
  runtime,
  rec,
  ctx,
  title,
  className,
  onReset,
}: {
  readonly lane: ImportedLane;
  readonly hands: Readonly<Record<string, { parts?: object }>>;
  readonly samples: RtLaneSamples | undefined;
  readonly machine: Machine<S, M, K, Sub<never>, Ctx>;
  readonly runtime: {
    getState: () => S;
    subscribe: (f: () => void) => () => void;
    dispatch: (m: M) => void;
  };
  readonly rec: Recorder<S, M>;
  readonly ctx: Ctx;
  readonly title: string | undefined;
  readonly className: string | undefined;
  readonly onReset: () => void;
}) {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => runtime.subscribe(bump), [runtime]);
  const live = runtime.getState();
  const trace = safeDump(rec, live);
  // `dump()` allocates a fresh tape every render, so the msgs ARRAY has a new
  // identity each time and keying the memo on it would re-replay the whole run
  // on every render. The tape only ever grows, so its LENGTH is the honest key
  // and the tape itself is read through a ref — the same trick, for the same
  // reason, as `<ChartInspector>`'s cmd capture.
  const tape = useRef(trace);
  tape.current = trace;
  const now = useRef(live);
  now.current = live;
  const total = trace.msgs.length;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `total` is not read in the body and is the whole point of the memo — it is the tape's length, the one thing that changes what the feed answers
  const feed = useMemo(
    () =>
      liveFeed(lane, {
        regionsAt: (n) =>
          regionsOf(
            replayPrefix(machine, tape.current, ctx, n, now.current),
            // a fold that threw leaves the live regions as the honest answer
            regionsOf(now.current, {}),
          ),
        msgs: tape.current.msgs,
        optsFor: (task) => ({
          ...(hands[task]?.parts === undefined
            ? {}
            : { parts: hands[task]?.parts as never }),
          ...(samples?.[task] === undefined
            ? {}
            : { samples: samples[task] as never }),
        }),
      }),
    [lane, hands, samples, machine, ctx, total],
  );

  return (
    <LanePanels
      feed={feed}
      title={title}
      className={className}
      send={(msg) => runtime.dispatch(msg as unknown as M)}
      onReset={onReset}
    />
  );
}

function containerClass(extra: string | undefined): string {
  return `tea-lv${extra ? ` ${extra}` : ""}`;
}

// ── the one presentation ──────────────────────────────────────────────────

/**
 * The panels. ONE component for both sources, and it takes `send` as data:
 * `null` is a source with no dispatch at all, and the reason is already on every
 * control's `send` field, so this component never has to know which source it
 * is looking at.
 */
function LanePanels({
  feed,
  title,
  className,
  send,
  onReset,
}: {
  readonly feed: LaneFeed;
  readonly title: string | undefined;
  readonly className: string | undefined;
  readonly send: ((msg: { readonly type: string }) => void) | null;
  readonly onReset?: () => void;
}) {
  // `null` is live (the end of the tape); a number is a step to look at.
  const [at, setAt] = useState<number | null>(null);
  const cursor = at === null ? feed.total : Math.min(at, feed.total);
  const view = laneView(feed, cursor, title);

  return (
    <div className={containerClass(className)} data-source={view.source}>
      <header className="tea-lv-head">
        <span className="tea-lv-title">{view.title}</span>
        <span className="tea-lv-src" data-source={view.source}>
          {view.source}
        </span>
        <span className="tea-lv-now" data-lane-status={view.status}>
          {view.terminal === null ? (
            <span className="tea-lv-phase">{view.activePhase ?? "—"}</span>
          ) : (
            <span className="tea-lv-terminal">{view.terminal}</span>
          )}
          <span className="tea-lv-status">{view.status}</span>
        </span>
        {view.scrubbed ? (
          <span className="tea-lv-warn">
            time-travelling — step {view.cursor} of {view.total}
          </span>
        ) : null}
      </header>

      {/* WHY NOTHING IS DISPATCHABLE — said ONCE, here.
          It used to be said on every control, which is where looking at a real
          rendered lane earned its keep: the sentence is a fact about the SOURCE,
          identical for all of them, and a phase with eight tasks × six events
          repeated it forty-eight times. The rule ("never a silently missing
          affordance") is kept — the reason is on screen, above every control it
          explains, and each disabled button still carries it as its title. */}
      {/* WHAT AM I LOOKING AT — one paragraph, in words, before any data.
          A reader who has never seen a lane cannot infer it from chips and
          arrows, and a page that needs explaining out loud is a page that has
          not finished. The counts are derived, so it stays true as it moves. */}
      <p className="tea-lv-lede">
        A <b>lane</b> is {view.phases.length} phase
        {view.phases.length === 1 ? "" : "s"} that run in order. Each phase
        holds tasks that run <i>at the same time</i>, and every task is one
        state machine — the diagram below it is that machine, with the state it
        is in right now lit up. A phase finishes when all of its tasks finish;{" "}
        {view.terminal === null ? (
          <>
            right now <b>{view.activePhase}</b> is the one running.
          </>
        ) : (
          <>
            this lane has ended, on <b>{view.terminal}</b>.
          </>
        )}
      </p>
      {sourceReason(view) === undefined ? null : (
        <p className="tea-lv-unavailable" data-unavailable="dispatch">
          {sourceReason(view)}
        </p>
      )}

      {/* 1 — WHICH OF TWELVE THINGS IS STUCK. First, because it is the first
          question anyone asks about an epic that stopped moving. */}
      <StuckPanel view={view} />

      {/* 2 — the phases, in order. The lane's own structure: N tasks each,
          running concurrently, and a standing per phase. */}
      {view.phases.map((phase) => (
        <PhasePanel key={phase.name} phase={phase} send={send} />
      ))}

      {/* 3 — the timeline, and the scrubber over it. */}
      <TimelinePanel
        view={view}
        onScrub={setAt}
        onLive={() => setAt(null)}
        onReset={onReset}
      />
    </div>
  );
}

function StuckPanel({ view }: { readonly view: LaneViewModel }) {
  return (
    <section className="tea-lv-panel tea-lv-stuck">
      <h3 className="tea-lv-h">
        1 · is anything blocked?
        <span className="tea-lv-hint">
          a task nothing can move until someone acts
        </span>
      </h3>
      {view.stuck.length === 0 ? (
        // Said, never left blank: "nothing is stuck" is an answer, and an empty
        // panel is the reader wondering whether the question was asked.
        <p className="tea-lv-none">
          nothing is stuck — every task can still move
        </p>
      ) : (
        <ul className="tea-lv-stucklist">
          {view.stuck.map((s) => (
            <li key={s.task} data-stuck={s.reason.kind} data-task={s.task}>
              <b>{s.task}</b> <span className="tea-lv-muted">({s.phase})</span>{" "}
              — {stuckLine(s.reason)}
            </li>
          ))}
        </ul>
      )}
      {view.tripped.length === 0 ? null : (
        <p className="tea-lv-tripped">tripped: {view.tripped.join(", ")}</p>
      )}
    </section>
  );
}

/** One stuck reason, as a sentence. The four kinds are not the same news. */
function stuckLine(reason: LaneTaskView["stuck"]): string {
  if (reason === null) return "";
  switch (reason.kind) {
    case "tripped":
      return `landed on the error final \`${reason.state}\` — as finished as a shipped task, and lost`;
    case "dead-end":
      return `\`${reason.state}\` routes no event and is not a final — nobody can move it`;
    case "budget-spent":
      return `\`${reason.state}\` has spent its retry budget — the next \`${reason.event}\` is \`${reason.landsOn}\`, not a retry`;
    case "awaiting-world":
      // The roles are the consumer's own words, carried through from `from`.
      return `\`${reason.state}\` moves only when ${reason.roles.join(" or ")} sends ${reason.events.map((e) => `\`${e}\``).join(" or ")} — no cmd or sub can arrive here`;
  }
}

function PhasePanel({
  phase,
  send,
}: {
  readonly phase: LanePhaseView;
  readonly send: ((msg: { readonly type: string }) => void) | null;
}) {
  const count = `${phase.tasks.length} task${phase.tasks.length === 1 ? "" : "s"}`;
  return (
    <section
      className={`tea-lv-panel tea-lv-phase-${phase.standing}`}
      data-phase={phase.name}
      data-standing={phase.standing}
    >
      <h3 className="tea-lv-h">
        {phase.index === 0 ? "2 · " : ""}
        {phase.name} <span className="tea-lv-standing">{phase.standing}</span>{" "}
        <span className="tea-lv-muted">{count} running together</span>
      </h3>
      <ul className="tea-lv-chips">
        {phase.tasks.map((task) => (
          <li
            key={task.task}
            className="tea-lv-chip"
            data-task={task.task}
            data-state={task.state}
            data-end={String(task.endPolarity)}
          >
            <b>{task.task}</b> = {task.state}
            {task.endPolarity === "error" ? " (tripped)" : ""}
          </li>
        ))}
      </ul>
      {/* THE CHIPS ARE THE SUMMARY, so a collapsed task must not repeat them.
          Each collapsed task used to render its own `task = state` disclosure
          directly under a chip row that had just said exactly that — every task
          listed twice, adjacent. Rendering a real phase of eight made it
          obvious and no assertion could.

          So: expanded tasks get their panel, and the rest go behind ONE
          disclosure. Nothing is lost — the collapsed panels are still whole and
          still one click away, which on a live lane keeps those regions
          dispatchable — and the phase reads as one line per task either way. */}
      {phase.tasks.map((task) => (
        <TaskPanel
          key={task.task}
          task={task}
          expanded={phase.expanded.includes(task.task)}
          send={send}
        />
      ))}
    </section>
  );
}

/**
 * One task. Expanded, or collapsed to a line with its picture behind a
 * disclosure — see the module doc for why the collapse is not a hole.
 */
function TaskPanel({
  task,
  expanded,
  send,
}: {
  readonly task: LaneTaskView;
  readonly expanded: boolean;
  readonly send: ((msg: { readonly type: string }) => void) | null;
}) {
  const waiting =
    task.waitingOn ??
    (task.endPolarity === "error"
      ? `nothing — this task landed on the error final \`${task.state}\`, and \`${task.phase}\` will trip the lane when its siblings finish`
      : "nothing — this task is final");

  // THE SAME BODY EITHER WAY, and that is the point of the disclosure: the
  // collapse hides the wall, it does not withhold the task. A live lane's
  // collapsed region is still dispatchable, one click of the triangle away —
  // which is exactly what a comment could not have offered.
  const body = (
    <>
      <p className="tea-lv-waiting">waiting on: {waiting}</p>
      <Budget task={task} />
      {/* THE CONTROL WALL, and why it is folded away on a replay.
          Six events × eight tasks is forty-eight boxes, and on a lane read from
          a log not one of them can be clicked — most of them say only that the
          event is not accepted here. That is true, and it is the answer to a
          question nobody asked while reading history. So on a replay they go
          behind a disclosure; on a LIVE lane, where a click actually moves the
          machine, they stay open. Reachable either way — never absent. */}
      {send === null ? (
        <details className="tea-lv-accepts">
          <summary>
            which events this state accepts (
            {task.controls.filter((c) => !c.refused).length} of{" "}
            {task.controls.length})
          </summary>
          <div className="tea-lv-controls">
            {task.controls.map((control) => (
              <Control key={control.event} control={control} send={send} />
            ))}
          </div>
        </details>
      ) : (
        <div className="tea-lv-controls">
          {task.controls.map((control) => (
            <Control key={control.event} control={control} send={send} />
          ))}
        </div>
      )}
      {/* KEYED BY THE DIAGRAM ITSELF, so scrubbing replaces the NODE.
          Every mermaid host marks what it has rendered (`data-processed`) and
          skips those nodes. React, updating in place, rewrites only the TEXT —
          the attribute survives, the host skips it forever, and from the second
          frame on the reader sees mermaid source instead of a picture. Found by
          dragging the timeline.

          A key derived from the content makes React unmount and remount, so the
          host meets a genuinely new node. One line, and it removes the trap for
          every host rather than documenting it for each. */}
      <pre key={task.diagram} className="mermaid tea-lv-mermaid">
        {task.diagram}
      </pre>
    </>
  );

  if (!expanded) {
    return (
      /* The chip row above already says `task = state` for every task in the
         phase. A collapsed disclosure that repeats it lists each task twice,
         adjacent — which reads as a bug and was one, found by rendering a real
         eight-task phase rather than by any assertion. So the summary says what
         the chip cannot: that there is more here, and whether it has begun. */
      <details className="tea-lv-task tea-lv-collapsed" data-task={task.task}>
        <summary>
          <b>{task.task}</b>{" "}
          <span className="tea-lv-muted">
            {task.moved ? "· details" : "· not started"}
          </span>
        </summary>
        {body}
      </details>
    );
  }

  return (
    <div className="tea-lv-task" data-task={task.task} data-expanded="true">
      <h4 className="tea-lv-taskh">
        <b>{task.task}</b> — <span className="tea-lv-state">{task.state}</span>
        {task.endPolarity === "error" ? (
          <span className="tea-lv-badge">tripped</span>
        ) : null}
        {task.was === undefined ? null : (
          <span className="tea-lv-muted"> · resumes to {task.was}</span>
        )}
      </h4>
      {body}
    </div>
  );
}

function Budget({ task }: { readonly task: LaneTaskView }) {
  if ("answerable" in task.budget) {
    return (
      <p
        className="tea-lv-unavailable"
        data-unavailable={task.budget.question}
        title={task.budget.why}
      >
        retries: not available — {task.budget.why}
      </p>
    );
  }
  // `0/2` is noise and `2/2` is the difference between "in review" and "one FAIL
  // from frozen" — `report.ts`'s rule, and the same one applies on a screen.
  if (task.budget.retries === 0) return null;
  return (
    <p className="tea-lv-retries" data-retries={task.budget.retries}>
      retries: {task.budget.retries}/{task.budget.maxRetries}
      {task.budget.retries >= task.budget.maxRetries ? " — spent" : ""}
    </p>
  );
}

/**
 * The source-level dispatch reason, if this source has one — the same sentence
 * every control would otherwise carry, read off the first one that has it.
 *
 * Read rather than hardcoded: the wording belongs to whoever built the feed, and
 * restating it here would be a second declaration site for one sentence.
 */
function sourceReason(view: LaneViewModel): string | undefined {
  for (const phase of view.phases) {
    for (const task of phase.tasks) {
      for (const control of task.controls) {
        if (!control.refused && "answerable" in control.send) {
          return (control.send as Unanswerable<"dispatch">).why;
        }
      }
    }
  }
  return undefined;
}

/**
 * One control. An unavailable one keeps its shape and loses its affordance, and
 * the REASON is the content — never a missing button.
 */
function Control({
  control,
  send,
}: {
  readonly control: LaneControl;
  readonly send: ((msg: { readonly type: string }) => void) | null;
}) {
  const unsendable = "answerable" in control.send;
  const msg = unsendable ? undefined : control.send;
  const why = unsendable
    ? (control.send as Unanswerable<"dispatch">).why
    : undefined;
  return (
    <div
      className={`tea-lv-ev tea-lv-ev-${control.kind}`}
      data-event={control.event}
      data-task={control.task}
      data-status={control.refused ? "refused" : "legal"}
      data-sendable={String(!unsendable && send !== null)}
    >
      <button
        type="button"
        className="tea-lv-btn"
        disabled={msg === undefined || send === null}
        title={control.why ?? why ?? control.outcome}
        onClick={() => {
          if (msg !== undefined && send !== null) send(msg);
        }}
      >
        {control.event}
      </button>
      <span className="tea-lv-to">
        {control.refused ? control.why : control.outcome}
      </span>
      {/* The source-level reason is NOT repeated here — it is stated once above
          every control it explains (see the header). It stays on this button's
          `title`, so the affordance is never silently missing.

          A REFUSED control is different and keeps its own reason inline as its
          content: the CHART refused this one, so it is specific to this control
          rather than a fact about the source, and which source is looking at it
          is beside the point. */}
    </div>
  );
}

function TimelinePanel({
  view,
  onScrub,
  onLive,
  onReset,
}: {
  readonly view: LaneViewModel;
  readonly onScrub: (n: number) => void;
  readonly onLive: () => void;
  readonly onReset: (() => void) | undefined;
}) {
  const clockless = "answerable" in view.clock;
  return (
    <section className="tea-lv-panel tea-lv-travel">
      <h3 className="tea-lv-h">
        3 · what happened, step by step
        <span className="tea-lv-hint">
          drag to rewind — everything above moves with it
        </span>
      </h3>
      <div className="tea-lv-scrub">
        <input
          type="range"
          min={0}
          max={view.total}
          value={view.cursor}
          aria-label="step"
          onChange={(e) => onScrub(Number(e.target.value))}
        />
        <span className="tea-lv-step">
          {view.cursor} / {view.total}
        </span>
        <button type="button" onClick={onLive} disabled={!view.scrubbed}>
          now
        </button>
        {onReset === undefined ? null : (
          <button type="button" onClick={onReset}>
            reset
          </button>
        )}
      </div>
      {clockless ? (
        <p
          className="tea-lv-unavailable"
          data-unavailable="clock"
          title={(view.clock as Unanswerable<"clock">).why}
        >
          when: not available — {(view.clock as Unanswerable<"clock">).why}
        </p>
      ) : null}
      {view.steps.length === 0 ? (
        <p className="tea-lv-none">
          no steps yet — every task is where it booted
        </p>
      ) : (
        <table className="tea-lv-steps">
          <thead>
            <tr>
              <th>#</th>
              {clockless ? null : <th>at</th>}
              <th>task</th>
              <th>event</th>
              <th>from → to</th>
            </tr>
          </thead>
          <tbody>
            {view.steps.map((step) => (
              <tr key={step.index} data-step={step.index}>
                <td>{step.index + 1}</td>
                {clockless ? null : (
                  <td>{(view.clock as readonly string[])[step.index]}</td>
                )}
                <td>{step.task}</td>
                <td>{step.event}</td>
                <td>
                  {step.from} → {step.to}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

// ── helpers ───────────────────────────────────────────────────────────────

/** A lane run state's regions, read back off whatever shape `replay` returned. */
function regionsOf(
  state: unknown,
  fallback: Readonly<Record<string, RunningLeaf>>,
): Readonly<Record<string, RunningLeaf>> {
  if (typeof state !== "object" || state === null) return fallback;
  const regions = (state as { regions?: unknown }).regions;
  return typeof regions === "object" && regions !== null
    ? (regions as Readonly<Record<string, RunningLeaf>>)
    : fallback;
}

/** The recorder's tape. `dump()` throws before the boot observe has fired. */
function safeDump<S, M extends { type: string }>(
  rec: Recorder<S, M>,
  live: S,
): Trace<S, M> {
  try {
    return rec.dump();
  } catch {
    return { loaded: null, msgs: [], finalState: live };
  }
}

/**
 * The lane after the first `n` recorded msgs, by PURE replay — `init` +
 * `update` only, never `interpret`, so scrubbing backwards re-derives history
 * rather than re-performing it.
 */
function replayPrefix<S, M extends { type: string }, K extends Cmd, Ctx>(
  machine: Machine<S, M, K, Sub<never>, Ctx>,
  trace: Trace<S, M>,
  ctx: Ctx,
  n: number,
  live: S,
): S {
  try {
    return replay(machine, {
      msgs: trace.msgs.slice(0, n),
      ctx,
      loaded: trace.loaded,
    }).state;
  } catch {
    return live;
  }
}
