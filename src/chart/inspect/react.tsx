/**
 * @packageDocumentation
 * @demlik/tea/chart/inspect/react — the chart inspector, as one component.
 *
 * ```tsx
 * <ChartInspector chart={lane} parts={{ assign, guards }} samples={samples}
 *                 boot={() => ({ retries: 0, maxRetries: 3 })} />
 * ```
 *
 * That is the whole page: a button per message, a live state panel, a state
 * diagram with the current node lit, and a time-travel scrubber over every
 * transition. None of it is configured. The message list, the state names, the
 * phases, which control is legal right now and why the others are refused are
 * all READ OFF THE CHART by `../inspect`'s headless core — which is the point:
 * a hand-built debugger page encodes those four facts a second time, and this
 * one cannot, because it never learns them from anywhere but the chart.
 *
 * WHAT THE AUTHOR STILL SUPPLIES, and why none of it is derivable:
 *
 *   - `parts` — the code the chart deliberately does not own (payload builders,
 *     guard bodies, cells). It is the same bag `compile` demands; the inspector
 *     compiles the machine itself rather than asking for one, so the diagram and
 *     the runtime provably come from the same chart.
 *   - `boot` — the initial state's DATA. The chart says which state is the entry
 *     (`initial: true`); it cannot say what `maxRetries` is.
 *   - `samples` — one payload per event that declares one. `ty<T>()` is `{}` at
 *     runtime, so no derivation recovers the shape. Typed by the chart all the
 *     same (see `Samples<C>`), and rendered as EDITABLE JSON so the operator can
 *     vary a payload and watch a guard's branch flip.
 *   - `ctx` — the runtime environment, which is not a property of the machine.
 *
 * WHAT WOULD FIRE, AND WHAT DID. The button row shows the cmds an edge
 * DECLARES — the before question, and empty by declaration on a `{ to, cell }`
 * edge, because the cell builds its cmds in its body. The "cmds fired" panel
 * shows what the recorded run ACTUALLY emitted, per step, tagged with the msg
 * that caused it. Two panels, because they answer two questions; the second is
 * the only place a cell-built effect is visible at all.
 *
 * THE REDUCER FORM has its own component, `<ReducerChartInspector>`, over the
 * same view. It renders the panels that apply and NAMES the ones that do not:
 * no phase on the header, no refusal on any control, no highlighted node in the
 * drawing — each listed in a "not available in this form" panel with the reason,
 * rather than quietly missing.
 *
 * TIME TRAVEL IS PURE. The runtime is recorded with `@demlik/tea/recorder`, and
 * scrubbing re-folds a PREFIX of the recorded msgs through `replay` — init +
 * update only, never `interpret`, never a Store, never a live subscription. So
 * dragging the scrubber backwards cannot re-fire an effect, which is the one
 * thing a naive time-travel implementation gets wrong.
 *
 * Styling follows `@demlik/tea/devtools`: one stylesheet, every class prefixed
 * (`tea-ci-*`), wired to the consumer's design tokens, no framework and no new
 * dependency. Import `@demlik/tea/chart/inspect/styles.css` (and devtools'
 * stylesheet, since the state/log/diff panels are devtools components).
 */

"use client";

import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  MsgLog,
  StateDiff,
  StateInspector,
  useMsgHistory,
} from "../../devtools";
import {
  type BootingRuntime,
  type Cmd,
  type Machine,
  type Runtime,
  replay,
  run,
  type Sub,
} from "../../index";
import type { Reducer, Transitions } from "../../pure/core";
import { type Recorder, recorder, type Trace } from "../../recorder";
import {
  chartMermaid,
  compile,
  compileReducer,
  initFrom,
  type Parts,
  type RParts,
  reducerInitFrom,
  reducerMermaid,
} from "../compile";
import type {
  Chart,
  CmdOf,
  InitialData,
  MsgOf,
  ReducerChart,
  RStateOf,
  StateOf,
} from "../graph";
import {
  type ChartDescription,
  type CmdCapture,
  captureCmds,
  describeChart,
  describeReducerChart,
  type EventPreview,
  inspectReducerState,
  inspectState,
  type ReducerChartDescription,
  type ReducerEventPreview,
  type RtSamples,
  type Samples,
} from "./index";

// ── props ─────────────────────────────────────────────────────────────────

/**
 * Everything `<ChartInspector>` needs. Four fields, and every one of them is a
 * fact the chart genuinely does not carry — see the module doc. Anything the
 * chart DOES carry (events, states, phases, guards, cmds, refusals) has no prop
 * here by design: a prop that restated one would be the fact said twice.
 */
export interface ChartInspectorProps<
  C,
  S extends { type: string },
  M extends { type: string },
  Ctx,
> {
  /** The chart. Everything the UI draws is read off this value. */
  readonly chart: C;
  /** The parts bag `compile` demands — assign, plus guards/cmds/cells if used. */
  readonly parts: Parts<C, S, M>;
  /** The entry state's data. The chart names the state; you supply its ctx. */
  readonly boot: () => InitialData<C, S>;
  /** One payload per event that declares one. Typed by the chart. */
  readonly samples?: Samples<C>;
  /** The runtime ctx. Omit for a machine that reads nothing from one. */
  readonly ctx?: Ctx;
  /** Diagram title. Cosmetic — defaults to no title. */
  readonly title?: string;
  /** Diagram direction. Default `"TB"`. */
  readonly direction?: "TB" | "LR";
  /** Appended to the container's class list. */
  readonly className?: string;
}

/**
 * Everything `<ReducerChartInspector>` needs — the same four undecidable facts,
 * over the form that has no phase dimension.
 *
 * There is no `direction` prop, and its absence is the honest kind: the reducer
 * drawing has one `any` node with every edge leaving it (that is what having no
 * phase dimension MEANS), so a layout knob would be a knob over nothing.
 */
export interface ReducerChartInspectorProps<
  C,
  S extends { type: string },
  M extends { type: string },
  Ctx,
> {
  /** The reducer chart. Everything the UI draws is read off this value. */
  readonly chart: C;
  /** The parts bag `compileReducer` demands. */
  readonly parts: RParts<C, S, M>;
  /** The entry state's data — for this form, the whole state minus its tag. */
  readonly boot: () => Omit<RStateOf<C>, "type">;
  /** One payload per event that declares one. Typed by the chart. */
  readonly samples?: Samples<C>;
  /** The runtime ctx. Omit for a machine that reads nothing from one. */
  readonly ctx?: Ctx;
  /** Panel title. Cosmetic — defaults to no title. */
  readonly title?: string;
  /** Appended to the container's class list. */
  readonly className?: string;
}

// ── the runtime lifecycle, shared by both forms ───────────────────────────

/**
 * Own a runtime for the component's lifetime (built with `run`, stopped on
 * unmount or reset) so the recorder has something to attach to — `useMachine`
 * hides the runtime, and the recorder needs it. The booted `Runtime` is
 * consumed with `useRuntime`'s contract: the component that owns the lifecycle
 * stops it.
 *
 * Shared by both chart forms because none of it is form-specific: a compiled
 * `Transitions` and a compiled `Reducer` are both just a `Machine["update"]`.
 *
 * EXPORTED for the one other component with the same lifecycle to own:
 * `@demlik/tea/chart/lane/react`'s live lane, whose `update` is `runLane`'s.
 * A lane is not a chart form, but "own a runtime for the component's lifetime,
 * record it, and stop it on unmount" is not a fact about charts either — and a
 * second copy of it is a second place for the recorder's stop to be forgotten.
 */
export function useInspectorRuntime<
  S,
  M extends { type: string },
  K extends Cmd,
  Ctx,
>(
  machine: Machine<S, M, K, Sub<never>, Ctx>,
  ctx: Ctx,
  epoch: number,
): { readonly rt: Runtime<S, M> | null; readonly rec: Recorder<S, M> } {
  // `epoch` is not read inside the memo, and it is still a real dependency: it
  // IS the reset lever. Bumping it is how "start over" rebuilds the runtime, so
  // re-booting the machine from `init` rather than pretending some message
  // means "go back to the beginning" — no chart has one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `epoch` is the reset lever — the memo must re-run when it bumps, which is the whole point of the value
  const booting = useMemo<BootingRuntime<S, M>>(
    () => run(machine, { ctx }),
    [machine, ctx, epoch],
  );
  const rec = useMemo<Recorder<S, M>>(() => recorder(booting), [booting]);

  // The booted handle. Until `ready` resolves there is no total `getState`, so
  // there is nothing honest to render — one frame of "booting" beats inventing
  // a state the machine has not produced.
  const [rt, setRt] = useState<Runtime<S, M> | null>(null);
  useEffect(() => {
    let live = true;
    setRt(null);
    booting.ready.then(
      (r) => {
        if (live) setRt(r);
      },
      () => {},
    );
    return () => {
      live = false;
      rec.stop();
      booting.stop().catch(() => {});
    };
  }, [booting, rec]);

  return { rt, rec };
}

// ── the components ────────────────────────────────────────────────────────

/**
 * The self-building debugger for any GRID-form chart.
 */
export function ChartInspector<
  const C extends Chart<C>,
  S extends { type: string } = StateOf<C>,
  M extends { type: string } = MsgOf<C>,
  K extends Cmd = CmdOf<C>,
  Ctx = Record<never, never>,
>(props: ChartInspectorProps<C, S, M, Ctx>) {
  const { chart, parts, boot, ctx } = props;
  // The reset lever: a fresh epoch rebuilds the runtime, which re-boots the
  // machine from `init`. Resetting by dispatching would be a lie — there is no
  // "go back to the start" message in any chart.
  const [epoch, reset] = useReducer((n: number) => n + 1, 0);

  const machine = useMemo(
    () =>
      ({
        init: initFrom<C, S, K>(chart, boot),
        // The one cast, at the construction boundary: `compile` returns a
        // `Transitions` over the chart's OWN derivations, and `S`/`M`/`K` are
        // the caller's names for exactly those.
        update: compile(chart, parts) as unknown as Transitions<S, M, K>,
      }) as unknown as Machine<S, M, K, Sub<never>, Ctx>,
    [chart, parts, boot],
  );
  const { rt, rec } = useInspectorRuntime(machine, ctx as Ctx, epoch);

  const desc = useMemo(() => describeChart(chart), [chart]);
  const view = useMemo<FormView<S>>(
    () => gridView(desc, chart, parts, props.title, props.direction),
    [desc, chart, parts, props.title, props.direction],
  );

  if (rt === null) {
    return (
      <div className={containerClass(props.className)}>
        <div className="tea-ci-boot">booting…</div>
      </div>
    );
  }
  return (
    <InspectorView
      key={epoch}
      view={view}
      samples={props.samples}
      runtime={rt}
      rec={rec}
      machine={machine}
      ctx={ctx as Ctx}
      title={props.title}
      className={props.className}
      onReset={reset}
    />
  );
}

/**
 * The same debugger for a REDUCER-form chart — the panels that apply, and the
 * ones that do not left out with the reason on screen.
 *
 * What is missing here is missing because the form does not have it: no phase
 * on the header, no refusal on any control (this form cannot refuse an event),
 * and no highlighted node in the drawing (every edge leaves the one `any`
 * node). The "not available in this form" panel names each one, so the
 * omission reads as a property of the chart rather than a hole in the tool.
 */
export function ReducerChartInspector<
  const C extends ReducerChart<C>,
  S extends { type: string } = RStateOf<C>,
  M extends { type: string } = MsgOf<C>,
  K extends Cmd = CmdOf<C>,
  Ctx = Record<never, never>,
>(props: ReducerChartInspectorProps<C, S, M, Ctx>) {
  const { chart, parts, boot, ctx } = props;
  const [epoch, reset] = useReducer((n: number) => n + 1, 0);

  const machine = useMemo(
    () =>
      ({
        init: reducerInitFrom<C, S, K>(chart, boot),
        // The one cast, for the same reason as the grid form's: `compileReducer`
        // returns a `Reducer` over the chart's OWN derivations.
        update: compileReducer(chart, parts) as unknown as Reducer<S, M, K>,
      }) as unknown as Machine<S, M, K, Sub<never>, Ctx>,
    [chart, parts, boot],
  );
  const { rt, rec } = useInspectorRuntime(machine, ctx as Ctx, epoch);

  const desc = useMemo(() => describeReducerChart(chart), [chart]);
  const view = useMemo<FormView<S>>(
    () => reducerView(desc, chart, parts),
    [desc, chart, parts],
  );

  if (rt === null) {
    return (
      <div className={containerClass(props.className)}>
        <div className="tea-ci-boot">booting…</div>
      </div>
    );
  }
  return (
    <InspectorView
      key={epoch}
      view={view}
      samples={props.samples}
      runtime={rt}
      rec={rec}
      machine={machine}
      ctx={ctx as Ctx}
      title={props.title}
      className={props.className}
      onReset={reset}
    />
  );
}

function containerClass(extra: string | undefined): string {
  return `tea-ci${extra ? ` ${extra}` : ""}`;
}

// ── the form seam ─────────────────────────────────────────────────────────

/** One event control, normalized so the two chart forms render through one row. */
interface ControlModel {
  readonly event: string;
  /** `"legal"` or the refusal's kind — the class suffix, and the CSS hook. */
  readonly kind: string;
  readonly refused: boolean;
  /** The refusal's one-line explanation. Present iff refused. */
  readonly why?: string;
  /** "where would this go, and what would it fire" — the DECLARED answer. */
  readonly outcome: string;
  /** The msg a click would dispatch, or `undefined` when no sample was given. */
  readonly msg?: { readonly type: string };
}

/**
 * The three things that differ between the chart forms, and nothing else.
 *
 * Everything below this line — the runtime, the recorder, time travel, the
 * drafts, the captured cmds — is identical for a grid chart and a reducer
 * chart, because none of it depends on there being a phase dimension. So the
 * view takes the difference as data rather than branching on it: `header`
 * returns no phase where there is no phase, `controls` returns rows that cannot
 * be refused where nothing can refuse them, and `omits` names each panel the
 * form cannot honestly fill.
 */
interface FormView<S extends { type: string }> {
  /** The alphabet, for seeding one payload draft per event that declares one. */
  readonly events: readonly {
    readonly name: string;
    readonly hasPayload: boolean;
  }[];
  readonly controls: (state: S, samples: RtSamples) => readonly ControlModel[];
  readonly mermaid: (state: S) => string;
  readonly header: (state: S) => {
    readonly phase?: string;
    readonly tags: readonly string[];
  };
  /** The questions this form cannot answer, each with the reason. */
  readonly omits: readonly {
    readonly question: string;
    readonly why: string;
  }[];
}

function gridView<C, S extends { type: string }, M extends { type: string }>(
  desc: ChartDescription,
  chart: C,
  parts: Parts<C, S, M>,
  title: string | undefined,
  direction: "TB" | "LR" | undefined,
): FormView<S> {
  return {
    events: desc.events,
    controls: (state, samples) =>
      inspectState(desc, state, { parts: parts as never, samples }).map(
        gridControl,
      ),
    mermaid: (state) =>
      chartMermaid(chart as never, {
        highlight: state.type,
        phases: true,
        direction,
        title,
      }),
    header: (state) => {
      const here = desc.states.find((s) => s.name === state.type);
      return {
        ...(here === undefined ? {} : { phase: here.phase }),
        tags: [
          ...(here?.end === true ? ["end"] : []),
          ...(here?.parking === true ? ["parking"] : []),
        ],
      };
    },
    omits: [],
  };
}

function reducerView<C, S extends { type: string }, M extends { type: string }>(
  desc: ReducerChartDescription,
  chart: C,
  parts: RParts<C, S, M>,
): FormView<S> {
  return {
    events: desc.events,
    controls: (state, samples) =>
      inspectReducerState(desc, state, {
        parts: parts as never,
        samples,
      }).map(reducerControl),
    // No `highlight`: every edge leaves the one `any` node, so there is no
    // node that IS the current state to light up.
    mermaid: () => reducerMermaid(chart as never),
    // No phase, no `end`, no `parking` — this form declares none of the three.
    header: () => ({ tags: [] }),
    omits: [desc.phases, desc.refusals, desc.scope],
  };
}

/** An `EventPreview` as a row: legality is a real question in the grid form. */
function gridControl(v: EventPreview): ControlModel {
  const refused = v.status === "refused";
  return {
    event: v.event,
    kind: refused ? (v.reason?.kind ?? "undeclared") : "legal",
    refused,
    ...(v.why === undefined ? {} : { why: v.why }),
    outcome: describeOutcome(v),
    ...(v.msg === undefined ? {} : { msg: v.msg }),
  };
}

/** A `ReducerEventPreview` as a row. It can never be refused — there is no
 * mechanism in this form with which to refuse it. */
function reducerControl(v: ReducerEventPreview): ControlModel {
  return {
    event: v.event,
    kind: "legal",
    refused: false,
    outcome: describeOutcome(v),
    ...(v.msg === undefined ? {} : { msg: v.msg }),
  };
}

// ── the view ──────────────────────────────────────────────────────────────

interface ViewProps<
  C,
  S extends { type: string },
  M extends { type: string },
  K extends Cmd,
  Ctx,
> {
  readonly view: FormView<S>;
  readonly samples: Samples<C> | undefined;
  readonly runtime: Runtime<S, M>;
  readonly rec: Recorder<S, M>;
  readonly machine: Machine<S, M, K, Sub<never>, Ctx>;
  readonly ctx: Ctx;
  readonly title: string | undefined;
  readonly className: string | undefined;
  readonly onReset: () => void;
}

function InspectorView<
  C,
  S extends { type: string },
  M extends { type: string },
  K extends Cmd,
  Ctx,
>({
  view,
  samples,
  runtime,
  rec,
  machine,
  ctx,
  title,
  className,
  onReset,
}: ViewProps<C, S, M, K, Ctx>) {
  // The live state, straight off the runtime (`useRuntime`'s subscription,
  // inlined here because this component also needs the recorder's view).
  const [tick, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => runtime.subscribe(bump), [runtime]);
  const liveState = runtime.getState();

  // Every dispatch goes through `useMsgHistory`, so the MsgLog rows and the
  // recorder's replay tape are fed by the same action.
  const [history, send] = useMsgHistory<M>(runtime.dispatch);

  // The editable payloads. Seeded from `samples`, then owned by the operator —
  // varying one is what makes the guard preview interactive.
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>(() =>
    seedDrafts(view.events, samples),
  );
  const effective = useMemo(() => parseDrafts(drafts), [drafts]);

  // Time travel. `at === null` is live; otherwise it is a msg-prefix length,
  // and the displayed state is that prefix re-folded through `replay`.
  const [at, setAt] = useState<number | null>(null);
  const trace = safeDump(rec, liveState);
  const total = trace.msgs.length;
  const cursor = at === null ? total : Math.min(at, total);
  const scrubbed = at !== null && cursor < total;

  const shown = replayPrefix(machine, trace, ctx, cursor, liveState);
  const previous = replayPrefix(
    machine,
    trace,
    ctx,
    Math.max(0, cursor - 1),
    liveState,
  );

  const verdicts = view.controls(shown, effective);
  const here = view.header(shown);

  // WHAT ACTUALLY FIRED, per step — the after question, folded from the same
  // recorded prefix the scrubber is already folding. `cursor` indexes both, so
  // the highlighted row is the transition on screen.
  // `rec.dump()` allocates a fresh tape every render, so the msgs ARRAY has a
  // new identity each time and keying the memo on it would re-fold the whole run
  // on every keystroke in a payload box. The tape only ever grows, so its LENGTH
  // is the honest key, and the tape itself is read through a ref.
  const tape = useRef(trace);
  tape.current = trace;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `total` is not read in the body and is the whole point of the memo — it is the tape's length, the one thing that changes what the capture returns
  const capture = useMemo<CmdCapture<M, K>>(
    () =>
      captureCmds(machine, {
        msgs: tape.current.msgs,
        ctx,
        loaded: tape.current.loaded,
      }),
    [machine, ctx, total],
  );

  return (
    <div className={containerClass(className)}>
      <header className="tea-ci-head">
        <span className="tea-ci-title">{title ?? "chart inspector"}</span>
        <span className="tea-ci-now">
          {here.phase === undefined ? null : (
            <span className="tea-ci-phase">{here.phase}</span>
          )}
          <span className="tea-ci-state">{shown.type}</span>
          {here.tags.map((t) => (
            <span className="tea-ci-tag" key={t}>
              {t}
            </span>
          ))}
        </span>
        {scrubbed ? (
          <span className="tea-ci-warn">
            time-travelling — step {cursor} of {total}
          </span>
        ) : null}
      </header>

      {/* 1 — the button row. One control per DECLARED event; a refused one is
          drawn as refused, with the reason, never omitted. */}
      <section className="tea-ci-panel tea-ci-events">
        {verdicts.map((v) => (
          <EventControl
            key={v.event}
            control={v}
            disabled={scrubbed}
            draft={drafts[v.event]}
            onDraft={(text) => setDrafts((d) => ({ ...d, [v.event]: text }))}
            onSend={() => {
              setAt(null);
              if (v.msg !== undefined) send(v.msg as unknown as M);
            }}
          />
        ))}
      </section>

      <div className="tea-ci-cols">
        {/* 2 — the live state, and what the last step changed. */}
        <section className="tea-ci-panel">
          <h3 className="tea-ci-h">state</h3>
          <StateInspector state={shown} flashKey={cursor + tick} />
          <h3 className="tea-ci-h">diff vs previous step</h3>
          <StateDiff expected={previous} actual={shown} />
        </section>

        {/* 3 — the diagram, with the current node lit where the form has one.
            `<pre class="mermaid">` is the shape a mermaid host renders in
            place; the text is readable either way, so the panel is useful with
            no renderer at all. */}
        <section className="tea-ci-panel">
          <h3 className="tea-ci-h">diagram</h3>
          <pre className="mermaid tea-ci-mermaid">{view.mermaid(shown)}</pre>
        </section>
      </div>

      {/* 4 — WHAT ACTUALLY FIRED. The button row above says what an edge
          DECLARES it would fire; this says what the recorded run did fire, per
          step, tagged with the msg that caused it — the only place a cmd built
          inside a cell body is visible at all. */}
      <section className="tea-ci-panel tea-ci-fired">
        <h3 className="tea-ci-h">cmds fired</h3>
        <ol className="tea-ci-firelog">
          {capture.steps.map((s) => (
            <li
              key={s.step}
              className={`tea-ci-fire${s.step === cursor ? " tea-ci-fire-now" : ""}`}
              data-step={s.step}
              data-fired={s.cmds.length}
            >
              <span className="tea-ci-fire-by">{s.by?.type ?? "init"}</span>
              <span className="tea-ci-fire-cmds">
                {s.cmds.length === 0
                  ? "—"
                  : s.cmds.map((c) => c.type).join(", ")}
              </span>
            </li>
          ))}
        </ol>
        {capture.stoppedAt === undefined ? null : (
          <span className="tea-ci-why">
            capture stopped at step {capture.stoppedAt.step}:{" "}
            {capture.stoppedAt.error}
          </span>
        )}
      </section>

      {/* 5 — the questions this chart form cannot answer, named rather than
          silently missing. Empty for a grid chart, which answers all three. */}
      {view.omits.length === 0 ? null : (
        <section className="tea-ci-panel tea-ci-omits">
          <h3 className="tea-ci-h">not available in this form</h3>
          <ul>
            {view.omits.map((o) => (
              <li key={o.question} data-omitted={o.question}>
                <b>{o.question}</b> — {o.why}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* 6 — time travel over every recorded transition. */}
      <section className="tea-ci-panel tea-ci-travel">
        <h3 className="tea-ci-h">time travel</h3>
        <div className="tea-ci-scrub">
          <input
            type="range"
            min={0}
            max={total}
            value={cursor}
            aria-label="transition"
            onChange={(e) => setAt(Number(e.target.value))}
          />
          <span className="tea-ci-step">
            {cursor} / {total}
            {cursor > 0 ? ` · ${String(trace.msgs[cursor - 1]?.type)}` : ""}
          </span>
          <button
            type="button"
            onClick={() => setAt(null)}
            disabled={!scrubbed}
          >
            live
          </button>
          <button type="button" onClick={onReset}>
            reset
          </button>
        </div>
        <MsgLog history={history} />
      </section>
    </div>
  );
}

// ── one event control ─────────────────────────────────────────────────────

function EventControl({
  control,
  disabled,
  draft,
  onDraft,
  onSend,
}: {
  readonly control: ControlModel;
  readonly disabled: boolean;
  readonly draft: string | undefined;
  readonly onDraft: (text: string) => void;
  readonly onSend: () => void;
}) {
  const { event, refused, kind, why, outcome, msg } = control;
  const blocked = refused || disabled || msg === undefined;
  return (
    <div
      className={`tea-ci-ev tea-ci-ev-${kind}`}
      data-event={event}
      data-status={refused ? "refused" : "legal"}
    >
      <button
        type="button"
        className="tea-ci-btn"
        disabled={blocked}
        title={why ?? outcome}
        onClick={onSend}
      >
        {event}
      </button>
      {refused ? (
        <span className="tea-ci-why">{why}</span>
      ) : (
        <span className="tea-ci-to">{outcome}</span>
      )}
      {draft === undefined ? null : (
        <textarea
          className="tea-ci-sample"
          aria-label={`${event} payload`}
          rows={1}
          value={draft}
          onChange={(e) => onDraft(e.target.value)}
        />
      )}
      {msg === undefined && !refused ? (
        <span className="tea-ci-why">no sample — cannot dispatch</span>
      ) : null}
    </div>
  );
}

/**
 * The one-line "where would this go, and what would it DECLARE it fires".
 *
 * Structural in its parameter, because a grid preview and a reducer preview
 * agree on exactly the four fields it reads — and disagree only about the
 * refusal, which never reaches here.
 */
function describeOutcome(v: {
  readonly guard?: EventPreview["guard"];
  readonly cmds: readonly string[];
  readonly targets: readonly string[];
  readonly resolved?: string;
}): string {
  const cmds = v.cmds.length > 0 ? ` / ${v.cmds.join(", ")}` : "";
  if (v.guard !== undefined) {
    return v.guard.branch === "unknown"
      ? `${v.targets.join(" | ")} — ${v.guard.guard}? (${v.guard.why})`
      : `→ ${v.guard.target} [${v.guard.branch === "then" ? "" : "!"}${v.guard.guard}]${cmds}`;
  }
  if (v.resolved !== undefined) return `→ ${v.resolved}${cmds}`;
  return `${v.targets.join(" | ")}${cmds}`;
}

// ── helpers ───────────────────────────────────────────────────────────────

/** One JSON draft per event that declares a payload. */
function seedDrafts(
  events: readonly { readonly name: string; readonly hasPayload: boolean }[],
  samples: unknown,
): Record<string, string> {
  const bag = (samples ?? {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const e of events) {
    if (!e.hasPayload) continue;
    out[e.name] = JSON.stringify(bag[e.name] ?? {});
  }
  return out;
}

/**
 * Parse the drafts back into a samples bag. An unparseable draft contributes
 * NOTHING rather than a stale value — which surfaces as the honest "no sample"
 * degradation in the guard preview instead of a silently ignored edit.
 */
function parseDrafts(
  drafts: Readonly<Record<string, string>>,
): Record<string, object | undefined> {
  const out: Record<string, object | undefined> = {};
  for (const [k, text] of Object.entries(drafts)) {
    try {
      const v: unknown = JSON.parse(text);
      if (typeof v === "object" && v !== null) out[k] = v;
    } catch {
      // left absent on purpose — see the doc above.
    }
  }
  return out;
}

/**
 * The recorder's tape. `dump()` throws before the boot observe has fired; the
 * view only renders post-boot, so the fallback is a formality — and a formality
 * beats a blank screen.
 */
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
 * The state after the first `n` recorded msgs, by PURE replay.
 *
 * `replay` runs `init` + `update` only. No `interpret`, no Store, no live
 * subscription — so scrubbing backwards re-derives history rather than
 * re-performing it, which is the whole difference between time travel and
 * re-running the app.
 */
function replayPrefix<
  S extends { type: string },
  M extends { type: string },
  K extends Cmd,
  Ctx,
>(
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
