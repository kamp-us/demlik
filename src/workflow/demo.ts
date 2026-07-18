/**
 * @demlik/tea/workflow — a runnable, deterministic Saga demo (#127, story 5 of
 * epic #118, the final child). The live demo the docs reference: the canonical
 * Saga `order → charge card → reserve inventory → ship`, each committed step
 * declaring the compensation that undoes it, driven through the #124 core + the
 * #125 reverse-order rollback along TWO scripted paths:
 *
 *   - the HAPPY path — all four activities succeed → the workflow settles
 *     `completed` carrying the final step's output;
 *   - the FORCED-FAILURE path — `ship` fails after `order`/`charge`/`reserve`
 *     committed → the engine PIVOTS into compensation and runs the completed
 *     steps' compensations in STRICT REVERSE order (`release inventory`, then
 *     `refund`, then `cancel order`) → settles `failed_compensated`.
 *
 * It is a thin, readable composition over the existing pure reducer
 * (`./index`): a fixed *activity performer* maps each dispatched activity (or
 * compensation) to a deterministic success/failure per a scripted scenario, and
 * a tiny driver folds the resulting result Msgs back through the verbs — exactly
 * how `foldWorkflow` replays a log, but here capturing the per-step trace the
 * narration reads. The whole run is pure, replayable, and byte-identical on
 * re-run: it owns NO clock, NO RNG, NO IO beyond an optional narration printer.
 * The reducer is already pure; the demo logic adds no impurity (mirroring how
 * `../raft/demo.ts` folds a fixed `Schedule`).
 *
 * Two entry points, mirroring the raft demo:
 *   - {@link runDemo} — drive both scenarios, return a structured
 *     {@link DemoResult} (the per-phase summary, the final status, the
 *     compensations run in unwind order, the full trace). Pure: it asserts
 *     nothing and prints nothing — the test and the CLI both read its result.
 *   - {@link narrateDemo} — render a {@link DemoResult} as readable lines (the
 *     `pnpm demo:saga` output). Pure string-building; the runner does the IO.
 *
 * Run it:  `pnpm --filter @demlik/tea demo:saga`
 * (see `src/workflow/README.md`).
 */

import {
  type ActivityCmd,
  type CompensationCmd,
  type CompletedStep,
  createWorkflow,
  type WorkflowCmd,
  type WorkflowMsg,
  type WorkflowState,
  type WorkflowSteps,
} from "./index";

// ===========================================================================
// The Saga — the canonical order-fulfilment transaction
// ===========================================================================

/**
 * The opaque activity payload (`A`). The reducer never inspects it — it only
 * sequences the steps and re-emits the owed dispatch on cold wake. The demo's
 * performer reads `op` to decide deterministically whether this activity
 * succeeds or fails; `label` is the human-readable line the narration prints.
 */
export interface SagaActivity {
  /** A stable operation key the performer scripts a result for. */
  readonly op: string;
  /** The human-readable description the narration renders. */
  readonly label: string;
}

/** The opaque activity result (`R`) — a forward step's confirmation receipt. */
export interface SagaReceipt {
  /** Which operation produced this receipt (echoes {@link SagaActivity.op}). */
  readonly op: string;
  /** The receipt detail the narration renders (e.g. an order id, a charge id). */
  readonly detail: string;
}

/** The opaque failure payload (`F`) — why a forward or inverse activity bounced. */
export interface SagaFailure {
  /** Which operation failed (echoes {@link SagaActivity.op}). */
  readonly op: string;
  /** The human-readable reason the narration renders. */
  readonly reason: string;
}

type SagaState = WorkflowState<SagaActivity, SagaReceipt, SagaFailure>;

/**
 * The four steps of the canonical Saga, in forward order. Each committed step
 * declares its compensation — the inverse that undoes it — so a downstream
 * failure unwinds the committed prefix in strict reverse (#125):
 *
 *   order            ⇄ cancel order
 *   charge card      ⇄ refund charge
 *   reserve inventory⇄ release inventory
 *   ship             ⇄ cancel shipment   (never runs in either path: in the
 *                       happy path it succeeds and is the final step; in the
 *                       failure path it never commits, so it owns no completed
 *                       step to compensate — its `compensation` is here only to
 *                       show a fully-symmetric saga definition.)
 */
export const SAGA_STEPS: WorkflowSteps<SagaActivity> = [
  {
    name: "order",
    activity: { op: "order", label: "place the order" },
    compensation: { op: "cancel-order", label: "cancel the order" },
  },
  {
    name: "charge",
    activity: { op: "charge", label: "charge the card" },
    compensation: { op: "refund", label: "refund the charge" },
  },
  {
    name: "reserve",
    activity: { op: "reserve", label: "reserve inventory" },
    compensation: { op: "release", label: "release the inventory" },
  },
  {
    name: "ship",
    activity: { op: "ship", label: "ship the package" },
    compensation: { op: "cancel-shipment", label: "cancel the shipment" },
  },
] as const;

// ===========================================================================
// The deterministic activity performer — the demo's only "side effect", faked
// ===========================================================================

/**
 * A scripted scenario: the set of forward operations that FAIL when performed.
 * Everything not named here succeeds. Compensations always succeed in the demo
 * (a `compensation_failed` path exists in the engine and is exercised by the
 * unit suite — the demo's failure path is the fully-unwound `failed_compensated`
 * story). This is the demo's entire source of nondeterminism, pinned to a fixed
 * value — no clock, no RNG.
 */
export interface Scenario {
  /** A human-readable scenario name (printed as the section headline). */
  readonly name: string;
  /** The forward `op`s scripted to fail. Empty ⇒ the happy path. */
  readonly failingOps: readonly string[];
}

/** The happy path — every activity succeeds. */
export const HAPPY_PATH: Scenario = {
  name: "Happy path — every step succeeds",
  failingOps: [],
};

/** The forced-failure path — `ship` fails after the first three steps commit. */
export const SHIP_FAILS: Scenario = {
  name: "Forced failure — ship fails, the saga rolls back",
  failingOps: ["ship"],
};

/**
 * Perform a forward activity deterministically per the scenario: a scripted
 * failure for any `op` in {@link Scenario.failingOps}, otherwise a success
 * carrying a stable receipt. FAKE — no payment gateway, no inventory backend,
 * no clock; the `detail` is derived purely from the op so the trace is
 * byte-identical on re-run.
 */
function performActivity(
  scenario: Scenario,
  activity: SagaActivity,
):
  | { readonly ok: true; readonly result: SagaReceipt }
  | {
      readonly ok: false;
      readonly failure: SagaFailure;
    } {
  if (scenario.failingOps.includes(activity.op)) {
    return {
      ok: false,
      failure: {
        op: activity.op,
        reason: `${activity.label} failed (scripted)`,
      },
    };
  }
  return {
    ok: true,
    result: { op: activity.op, detail: `${activity.op}#ok` },
  };
}

// ===========================================================================
// The trace — one entry per result the driver folded back into the reducer
// ===========================================================================

/** What kind of result one trace entry recorded. */
export type TraceKind =
  | "activity_ok"
  | "activity_err"
  | "compensation_ok"
  | "compensation_err";

/** One folded result: the dispatch it answered + the status it produced. */
export interface TraceEntry {
  /** Which kind of result this entry folded. */
  readonly kind: TraceKind;
  /** The step name the dispatch belonged to. */
  readonly step: string;
  /** The activity/compensation label that was performed. */
  readonly label: string;
  /** The workflow status AFTER this result was folded. */
  readonly status: SagaState["status"];
}

// ===========================================================================
// Driving one scenario through the pure reducer
// ===========================================================================

/** The structured outcome of driving ONE scenario to its terminal state. */
export interface ScenarioOutcome {
  /** The scenario that produced this outcome. */
  readonly scenario: Scenario;
  /** The terminal workflow status (`completed` / `failed_compensated` / …). */
  readonly status: SagaState["status"];
  /** The forward steps that committed (their activity succeeded), in order. */
  readonly committed: readonly string[];
  /**
   * The step names whose compensation ran, in the order they ran — STRICTLY the
   * reverse of {@link committed} for the failure path, empty for the happy path.
   * This is the headline #127 property: the demo SHOWS reverse-order rollback.
   */
  readonly compensated: readonly string[];
  /** The final output (happy path only — the last step's receipt). */
  readonly output: SagaReceipt | null;
  /** Every result folded, in fold order — the full per-step trace. */
  readonly trace: readonly TraceEntry[];
}

/**
 * Look up a step's human-readable label by the dispatched Cmd. Forward Cmds
 * carry an `activity`; compensation Cmds carry a `compensation` — read the one
 * present so the trace line matches what was performed.
 */
function labelOf(cmd: WorkflowCmd<SagaActivity>): string {
  return cmd.type === "workflow_activity"
    ? cmd.activity.label
    : cmd.compensation.label;
}

/** The step the dispatched Cmd belongs to (by its index into {@link SAGA_STEPS}). */
function stepNameOf(cmd: WorkflowCmd<SagaActivity>): string {
  return SAGA_STEPS[cmd.index]?.name ?? `step#${cmd.index}`;
}

/**
 * Drive one scenario from `init` to a terminal state, returning a structured
 * {@link ScenarioOutcome}. PURE: the only impurity a real workflow would have —
 * actually performing the activity — is replaced by the deterministic
 * {@link performActivity}, so two drives of the same scenario are byte-identical.
 *
 * The loop is the consumer's interpret cell made explicit: each verb returns the
 * dispatch Cmd(s) carrying their #67 delivery id; we PERFORM each dispatched
 * activity/compensation and route its result Msg (echoing that exact id) back
 * into the matching verb, exactly as a host's interpret cell would. We stop when
 * a verb emits no further Cmd — the workflow has settled (terminal).
 */
export function runScenario(scenario: Scenario): ScenarioOutcome {
  const wf = createWorkflow<SagaActivity, SagaReceipt, SagaFailure>();

  let step = wf.init(SAGA_STEPS);
  let state: SagaState = step.state;
  const trace: TraceEntry[] = [];

  // A bounded drive: each iteration performs the single in-flight dispatch and
  // folds its result. The bound guards against a pathological loop — there are
  // 4 forward + ≤4 reverse steps, so 16 is comfortably generous.
  let guard = 0;
  while (step.cmds.length > 0 && guard < 16) {
    guard++;
    // The reducer holds at most ONE effect in flight per workflow (confirm-then-
    // owe discipline), so there is exactly one Cmd to perform here.
    const cmd = step.cmds[0];
    if (cmd === undefined) break;

    const next = foldOneResult(wf, state, cmd, scenario);
    trace.push(next.entry);
    state = next.step.state;
    step = next.step;
  }

  return summarize(scenario, state, trace);
}

/**
 * Perform one dispatched Cmd against the scenario and fold its result back into
 * the reducer, returning the next reducer step plus the trace entry it produced.
 * Forward activities consult {@link performActivity}; compensations always take
 * (see {@link Scenario}). The result Msg echoes the Cmd's delivery `id` — the
 * dedup key the verb matches against the in-flight effect.
 */
function foldOneResult(
  wf: ReturnType<typeof createWorkflow<SagaActivity, SagaReceipt, SagaFailure>>,
  state: SagaState,
  cmd: WorkflowCmd<SagaActivity>,
  scenario: Scenario,
): {
  readonly step: ReturnType<typeof wf.onActivityOk>;
  readonly entry: TraceEntry;
} {
  const stepName = stepNameOf(cmd);
  const label = labelOf(cmd);

  if (cmd.type === "workflow_activity") {
    const activityCmd: ActivityCmd<SagaActivity> = cmd;
    const outcome = performActivity(scenario, activityCmd.activity);
    if (outcome.ok) {
      const msg: WorkflowMsg<SagaReceipt, SagaFailure> = {
        type: "activity_ok",
        id: activityCmd.id,
        result: outcome.result,
      };
      const next = wf.onActivityOk(state, msg);
      return {
        step: next,
        entry: {
          kind: "activity_ok",
          step: stepName,
          label,
          status: next.state.status,
        },
      };
    }
    const msg: WorkflowMsg<SagaReceipt, SagaFailure> = {
      type: "activity_err",
      id: activityCmd.id,
      failure: outcome.failure,
    };
    const next = wf.onActivityErr(state, msg);
    return {
      step: next,
      entry: {
        kind: "activity_err",
        step: stepName,
        label,
        status: next.state.status,
      },
    };
  }

  // A compensation dispatch — always succeeds in the demo's failure path.
  const compCmd: CompensationCmd<SagaActivity> = cmd;
  const msg: WorkflowMsg<SagaReceipt, SagaFailure> = {
    type: "compensation_ok",
    id: compCmd.id,
  };
  const next = wf.onCompensationOk(state, msg);
  return {
    step: next,
    entry: {
      kind: "compensation_ok",
      step: stepName,
      label,
      status: next.state.status,
    },
  };
}

/** Read the committed step names off any terminal/in-flight state. */
function committedNames(
  completed: readonly CompletedStep<SagaActivity, SagaReceipt>[],
): readonly string[] {
  return completed.map((c) => c.step.name);
}

/**
 * Fold a finished drive into a {@link ScenarioOutcome}. Reads the committed
 * forward steps and — from the trace — the compensations that ran, in the order
 * they ran (so the reverse-order rollback is visible in the data, not just the
 * narration).
 */
function summarize(
  scenario: Scenario,
  state: SagaState,
  trace: readonly TraceEntry[],
): ScenarioOutcome {
  const compensated = trace
    .filter((t) => t.kind === "compensation_ok")
    .map((t) => t.step);

  // Every WorkflowState variant carries `completed`; `failed` carries an empty
  // one by construction, so this reads correctly across all statuses.
  const committed = committedNames(state.completed);

  const output = state.status === "completed" ? state.output : null;

  return {
    scenario,
    status: state.status,
    committed,
    compensated,
    output,
    trace,
  };
}

// ===========================================================================
// The demo result — what runDemo returns (the test + the CLI both read this)
// ===========================================================================

/** The structured outcome of a full demo run — pure data, asserts nothing. */
export interface DemoResult {
  /** The Saga's step names, in forward order. */
  readonly steps: readonly string[];
  /** The happy-path scenario outcome (settles `completed`). */
  readonly happy: ScenarioOutcome;
  /** The forced-failure scenario outcome (settles `failed_compensated`). */
  readonly rollback: ScenarioOutcome;
}

/**
 * Drive BOTH scenarios against a fresh workflow each and return a structured
 * {@link DemoResult}. Pure: each scenario is folded through the reducer with the
 * deterministic performer, so the same input yields a byte-identical result —
 * {@link runDemo}() deep-equals runDemo().
 */
export function runDemo(): DemoResult {
  return {
    steps: SAGA_STEPS.map((s) => s.name),
    happy: runScenario(HAPPY_PATH),
    rollback: runScenario(SHIP_FAILS),
  };
}

// ===========================================================================
// Narration — render a DemoResult as readable lines (the CLI output)
// ===========================================================================

/** One trace entry as a compact, arrowed line. */
function traceLine(entry: TraceEntry): string {
  const mark =
    entry.kind === "activity_ok"
      ? "✓"
      : entry.kind === "activity_err"
        ? "✗"
        : entry.kind === "compensation_ok"
          ? "↩"
          : "✗↩";
  const verb =
    entry.kind === "activity_ok"
      ? "did"
      : entry.kind === "activity_err"
        ? "FAILED"
        : entry.kind === "compensation_ok"
          ? "undid"
          : "FAILED to undo";
  return `    ${mark} ${verb}: ${entry.label.padEnd(20)} → ${entry.status}`;
}

/** Render one scenario's outcome as a titled block. */
function narrateScenario(outcome: ScenarioOutcome): string[] {
  const lines: string[] = [];
  lines.push("");
  lines.push(outcome.scenario.name);
  lines.push(`  committed (forward):    [${outcome.committed.join(" → ")}]`);
  lines.push(
    `  compensated (reverse):  [${outcome.compensated.join(" → ") || "—"}]`,
  );
  lines.push(`  final status:           ${outcome.status}`);
  if (outcome.output) {
    lines.push(`  output:                 ${outcome.output.detail}`);
  }
  lines.push("  trace:");
  for (const entry of outcome.trace) {
    lines.push(traceLine(entry));
  }
  return lines;
}

/**
 * Render a {@link DemoResult} as a readable, deterministic narrative — the
 * `pnpm demo:saga` output. Pure: returns the lines; the runner prints them.
 */
export function narrateDemo(result: DemoResult): string {
  const lines: string[] = [];
  lines.push("=".repeat(72));
  lines.push("  @demlik/tea/workflow — Saga rollback demo (deterministic)");
  lines.push(`  saga: ${result.steps.join(" → ")}`);
  lines.push("=".repeat(72));

  lines.push(...narrateScenario(result.happy));
  lines.push(...narrateScenario(result.rollback));

  // Spell out the headline property: the rollback ran the committed steps'
  // compensations in STRICT REVERSE order.
  const committed = result.rollback.committed;
  const expectedReverse = [...committed].reverse();
  const isReverse =
    JSON.stringify(result.rollback.compensated) ===
    JSON.stringify(expectedReverse);

  lines.push("");
  lines.push("-".repeat(72));
  lines.push("  Summary");
  lines.push(
    `  happy path:        ${result.happy.status} (output ${result.happy.output?.detail ?? "none"})`,
  );
  lines.push(`  forced failure:    ${result.rollback.status}`);
  lines.push(`  committed before failure: [${committed.join(" → ")}]`);
  lines.push(
    `  rolled back (reverse):    [${result.rollback.compensated.join(" → ")}]`,
  );
  lines.push(
    `  reverse-order rollback: ${isReverse ? "OK — compensations ran in strict reverse of the committed steps" : "NOT observed"}`,
  );
  lines.push("-".repeat(72));
  return lines.join("\n");
}

// ===========================================================================
// Replay helper — prove the demo is byte-identically reproducible
// ===========================================================================

/**
 * Re-run both scenarios from scratch and report whether the result is identical
 * to the original run (the determinism contract). Used by the test and surfaced
 * in the CLI footer.
 */
export function demoIsReproducible(result: DemoResult): boolean {
  return JSON.stringify(runDemo()) === JSON.stringify(result);
}
