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

import { useEffect, useMemo, useReducer, useState } from "react";
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
import type { Transitions } from "../../pure/core";
import { type Recorder, recorder, type Trace } from "../../recorder";
import { chartMermaid, compile, initFrom, type Parts } from "../compile";
import type { Chart, CmdOf, InitialData, MsgOf, StateOf } from "../graph";
import {
  type ChartDescription,
  describeChart,
  type EventPreview,
  inspectState,
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

// ── the component ─────────────────────────────────────────────────────────

/**
 * The self-building debugger for any chart.
 *
 * Owns a runtime for its own lifetime (built with `run`, stopped on unmount or
 * reset) so the recorder has something to attach to — `useMachine` hides the
 * runtime, and the recorder needs it. The booted `Runtime` is consumed with
 * `useRuntime`'s contract: the component that owns the lifecycle stops it.
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

  // `epoch` is not read inside the memo, and it is still a real dependency: it
  // IS the reset lever. Bumping it is how "start over" rebuilds the runtime, so
  // re-booting the machine from `init` rather than pretending some message
  // means "go back to the beginning" — no chart has one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `epoch` is the reset lever — the memo must re-run when it bumps, which is the whole point of the value
  const booting = useMemo<BootingRuntime<S, M>>(
    () => run(machine, { ctx: ctx as Ctx }),
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

  const desc = useMemo(() => describeChart(chart), [chart]);

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
      desc={desc}
      chart={chart}
      parts={parts}
      samples={props.samples}
      runtime={rt}
      rec={rec}
      machine={machine}
      ctx={ctx as Ctx}
      title={props.title}
      direction={props.direction}
      className={props.className}
      onReset={reset}
    />
  );
}

function containerClass(extra: string | undefined): string {
  return `tea-ci${extra ? ` ${extra}` : ""}`;
}

// ── the view ──────────────────────────────────────────────────────────────

interface ViewProps<
  C,
  S extends { type: string },
  M extends { type: string },
  K extends Cmd,
  Ctx,
> {
  readonly desc: ChartDescription;
  readonly chart: C;
  readonly parts: Parts<C, S, M>;
  readonly samples: Samples<C> | undefined;
  readonly runtime: Runtime<S, M>;
  readonly rec: Recorder<S, M>;
  readonly machine: Machine<S, M, K, Sub<never>, Ctx>;
  readonly ctx: Ctx;
  readonly title: string | undefined;
  readonly direction: "TB" | "LR" | undefined;
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
  desc,
  chart,
  parts,
  samples,
  runtime,
  rec,
  machine,
  ctx,
  title,
  direction,
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
    seedDrafts(desc, samples),
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

  const verdicts = inspectState(desc, shown, {
    parts: parts as never,
    samples: effective,
  });
  const here = desc.states.find((s) => s.name === shown.type);

  return (
    <div className={containerClass(className)}>
      <header className="tea-ci-head">
        <span className="tea-ci-title">{title ?? "chart inspector"}</span>
        <span className="tea-ci-now">
          <span className="tea-ci-phase">{here?.phase ?? "?"}</span>
          <span className="tea-ci-state">{shown.type}</span>
          {here?.end === true ? <span className="tea-ci-tag">end</span> : null}
          {here?.parking === true ? (
            <span className="tea-ci-tag">parking</span>
          ) : null}
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
            verdict={v}
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

        {/* 3 — the diagram, with the current node lit. `<pre class="mermaid">`
            is the shape a mermaid host renders in place; the text is readable
            either way, so the panel is useful with no renderer at all. */}
        <section className="tea-ci-panel">
          <h3 className="tea-ci-h">diagram</h3>
          <pre className="mermaid tea-ci-mermaid">
            {chartMermaid(chart as never, {
              highlight: shown.type,
              phases: true,
              direction,
              title,
            })}
          </pre>
        </section>
      </div>

      {/* 4 — time travel over every recorded transition. */}
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
  verdict,
  disabled,
  draft,
  onDraft,
  onSend,
}: {
  readonly verdict: EventPreview;
  readonly disabled: boolean;
  readonly draft: string | undefined;
  readonly onDraft: (text: string) => void;
  readonly onSend: () => void;
}) {
  const refused = verdict.status === "refused";
  const kind = refused ? (verdict.reason?.kind ?? "undeclared") : "legal";
  const blocked = refused || disabled || verdict.msg === undefined;
  return (
    <div
      className={`tea-ci-ev tea-ci-ev-${kind}`}
      data-event={verdict.event}
      data-status={verdict.status}
    >
      <button
        type="button"
        className="tea-ci-btn"
        disabled={blocked}
        title={verdict.why ?? verdict.targets.join(" | ")}
        onClick={onSend}
      >
        {verdict.event}
      </button>
      {refused ? (
        <span className="tea-ci-why">{verdict.why}</span>
      ) : (
        <span className="tea-ci-to">{describeOutcome(verdict)}</span>
      )}
      {draft === undefined ? null : (
        <textarea
          className="tea-ci-sample"
          aria-label={`${verdict.event} payload`}
          rows={1}
          value={draft}
          onChange={(e) => onDraft(e.target.value)}
        />
      )}
      {verdict.msg === undefined && !refused ? (
        <span className="tea-ci-why">no sample — cannot dispatch</span>
      ) : null}
    </div>
  );
}

/** The one-line "where would this go, and what would it fire". */
function describeOutcome(v: EventPreview): string {
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
  desc: ChartDescription,
  samples: unknown,
): Record<string, string> {
  const bag = (samples ?? {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const e of desc.events) {
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
