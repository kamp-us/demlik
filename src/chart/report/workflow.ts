// ═══════════════════════════════════════════════════════════════════════════
// THE IMPORTER — one fabrika `workflow.json` in, one chart per task out.
//
// This is the mirror of `kamp-us/phoenix` `packages/fabrika-cli/src/lane/
// machine.ts`, and it is deliberately STRUCTURAL in exactly the same three
// places, because that is what makes the two agree:
//
//   an `on` string           → `{ target }`
//   an `on` two-arm array    → `{ target, when, otherwise }`   (guarded)
//   a target of `type: "history"` → `{ resume: { fallback: <region initial> } }`
//   `type: "final"`          → `end: true`
//   …reached as an array's fallthrough → `end: "error"`
//   machine-level `type: "parallel"` → a phase; its `onDone` pair → the terminals
//
// No guard name and no action name is ever dereferenced here, for the same
// reason fabrika does not dereference them: the ARRAY is the guard. The name
// travels into the chart's `when` because the chart draws it, and the fold
// applies the one inline predicate (`retries < maxRetries`) the compiler
// applies, whatever the name says.
// ═══════════════════════════════════════════════════════════════════════════

/** The operator's whole event vocabulary — fabrika's six, closed. */
export const OPERATOR_EVENTS = [
  "DONE",
  "PASS",
  "FAIL",
  "BLOCKED",
  "WIP",
  "UNBLOCKED",
] as const;

export type OperatorEvent = (typeof OPERATOR_EVENTS)[number];

export const isOperatorEvent = (event: string): event is OperatorEvent =>
  (OPERATOR_EVENTS as readonly string[]).includes(event);

/** `TASK_1.DONE` and `DONE` are the same event; the namespace is presentation. */
export const bareEvent = (event: string): string => {
  const dot = event.indexOf(".");
  return dot === -1 ? event : event.slice(dot + 1);
};

// ── the imported chart's shape ─────────────────────────────────────────────
//
// RUNTIME-TYPED, and the doc comment on `chartFromWorkflow` says why. These
// interfaces are the chart's VALUE shape narrowed to the three edge forms a
// fabrika region can produce — not `Chart<C>`, whose whole content is literal
// types recovered from a literal the compiler can see.

/** A declarative edge, in the only three forms a lane region can produce. */
export type ImportedEdge =
  | { readonly target: string }
  | {
      readonly target: string;
      readonly when: string;
      readonly otherwise: string;
    }
  | { readonly resume: { readonly fallback: string } };

export interface ImportedNode {
  readonly initial?: true;
  readonly on?: Readonly<Record<string, ImportedEdge>>;
  /** `true` success final, `"error"` the fallthrough final that trips the lane. */
  readonly end?: true | "error";
}

/** One task's region, as a chart value. One phase group, named by the phase. */
export interface ImportedChart {
  readonly events: Readonly<Record<string, { readonly scope: "edges" }>>;
  readonly states: Readonly<
    Record<string, Readonly<Record<string, ImportedNode>>>
  >;
}

export interface ImportedPhase {
  readonly name: string;
  readonly tasks: readonly string[];
}

export interface ImportedLane {
  /** The document's own `id`, when it carries one. */
  readonly id?: string;
  /** What fires this lane — a chore workflow's own field, carried not invented. */
  readonly trigger?: string;
  readonly phases: readonly ImportedPhase[];
  /** The workflow's two terminals, read off the last phase's `onDone` pair. */
  readonly terminals: { readonly complete: string; readonly tripped: string };
  /** One chart per task id — the ask's `charts`. */
  readonly charts: Readonly<Record<string, ImportedChart>>;
  /**
   * The document's `context` per task, minus the retry bookkeeping the fold
   * owns. `maxRetries` is split out because it is a transition input, not a
   * passenger — the guarded arm reads it.
   */
  readonly context: Readonly<
    Record<
      string,
      {
        readonly maxRetries: number;
        readonly extras: Readonly<Record<string, unknown>>;
      }
    >
  >;
}

/**
 * The document does not fit — with EVERY defect named, never a half-import.
 *
 * Same contract as fabrika's `Malformed`: a `workflow.json` that cannot be
 * compiled comes back as a list of reasons rather than as a machine that works
 * for some states. Thrown rather than returned because the chart module's other
 * doors throw too (`initialStateOf`, `CellTargetError`) and an importer that
 * returned a union would be the only one a caller could forget to check.
 */
export class WorkflowImportError extends Error {
  override readonly name = "WorkflowImportError";
  readonly _tag = "WorkflowImportError" as const;
  constructor(public readonly defects: readonly string[]) {
    super(
      `@demlik/tea: this workflow.json does not compile to charts —\n` +
        defects.map((d) => `  • ${d}`).join("\n"),
    );
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const nodeType = (node: unknown): string | undefined =>
  isRecord(node) && typeof node.type === "string" ? node.type : undefined;

/** The retry budget a document inherits when its `context` names none. */
const RETRY_BUDGET = 2;

/** The `when` a guarded arm carries when the document names no guard. */
const DEFAULT_GUARD = "retriesRemaining";

interface RegionImport {
  readonly node?: Readonly<Record<string, ImportedNode>>;
  readonly defects: readonly string[];
}

/** One task region → the phase group's state bag. `hist` is DROPPED, not kept. */
function importRegion(taskId: string, region: unknown): RegionImport {
  const defects: string[] = [];
  if (
    !isRecord(region) ||
    !isRecord(region.states) ||
    typeof region.initial !== "string"
  ) {
    return {
      defects: [
        `task "${taskId}": region must carry string \`initial\` and \`states\``,
      ],
    };
  }
  const states = region.states;
  const initialState = region.initial;
  if (states[initialState] === undefined) {
    defects.push(
      `task "${taskId}": initial state "${initialState}" is not in \`states\``,
    );
  }

  // Pass 1: which names are finals at all. The polarity needs the whole set
  // before any edge is read, because an error final is recognised by the edge
  // that REACHES it and the edge may be declared before the state.
  const finals = new Set<string>();
  for (const [name, node] of Object.entries(states)) {
    if (nodeType(node) === "final") finals.add(name);
  }
  const errorFinals = new Set<string>();

  // Pass 2: the edges.
  const on: Record<string, Record<string, ImportedEdge>> = {};
  for (const [stateName, node] of Object.entries(states)) {
    // `hist` IS a state node in the document and is NOT a chart state: the
    // chart carries history as a property of the EDGE (`resume`), which is why
    // it needs no pseudo-state to point at. Dropping it here is the same drop
    // fabrika's compiler makes, one line above its own table build.
    if (nodeType(node) === "history") continue;
    const edges: Record<string, ImportedEdge> = {};
    on[stateName] = edges;
    if (!isRecord(node)) {
      defects.push(`task "${taskId}": state "${stateName}" is not an object`);
      continue;
    }
    const raw = node.on ?? {};
    if (!isRecord(raw)) {
      defects.push(
        `task "${taskId}": state "${stateName}" carries a non-object \`on\``,
      );
      continue;
    }
    for (const [eventName, transition] of Object.entries(raw)) {
      const event = bareEvent(eventName);
      if (!isOperatorEvent(event)) {
        defects.push(
          `task "${taskId}": state "${stateName}" listens for "${eventName}" — outside the operator's six (${OPERATOR_EVENTS.join("/")})`,
        );
        continue;
      }

      // ── the guarded array ────────────────────────────────────────────────
      if (Array.isArray(transition)) {
        const arms = transition.map((arm) =>
          isRecord(arm) && typeof arm.target === "string"
            ? arm.target
            : undefined,
        );
        const [retry, fallthrough] = arms;
        if (
          transition.length !== 2 ||
          retry === undefined ||
          fallthrough === undefined
        ) {
          defects.push(
            `task "${taskId}": guarded "${eventName}" must be a two-arm array of \`{target}\` — [retry-while-retries-remain, else-fallthrough]`,
          );
          continue;
        }
        for (const target of [retry, fallthrough]) {
          if (states[target] === undefined) {
            defects.push(
              `task "${taskId}": "${eventName}" targets unknown state "${target}"`,
            );
          }
        }
        // THE POLARITY, recognised exactly where fabrika recognises it: a final
        // reached as the fallthrough is the task's error terminal.
        if (finals.has(fallthrough)) errorFinals.add(fallthrough);
        const head = transition[0];
        const when =
          isRecord(head) && typeof head.guard === "string"
            ? head.guard
            : DEFAULT_GUARD;
        edges[event] = { target: retry, when, otherwise: fallthrough };
        continue;
      }

      if (typeof transition !== "string") {
        defects.push(
          `task "${taskId}": "${eventName}" is neither a target nor a guarded array`,
        );
        continue;
      }
      if (states[transition] === undefined) {
        defects.push(
          `task "${taskId}": "${eventName}" targets unknown state "${transition}"`,
        );
        continue;
      }
      // ── the history target ───────────────────────────────────────────────
      edges[event] =
        nodeType(states[transition]) === "history"
          ? { resume: { fallback: initialState } }
          : { target: transition };
    }
  }

  if (defects.length > 0) return { defects };

  const out: Record<string, ImportedNode> = {};
  for (const [name, node] of Object.entries(states)) {
    if (nodeType(node) === "history") continue;
    const edges = on[name] ?? {};
    const isFinal = finals.has(name);
    out[name] = {
      ...(name === initialState ? { initial: true as const } : {}),
      ...(Object.keys(edges).length > 0 ? { on: edges } : {}),
      ...(isFinal
        ? { end: errorFinals.has(name) ? ("error" as const) : (true as const) }
        : {}),
    };
  }
  return { node: out, defects: [] };
}

/** The two targets of a phase's `onDone` pair: `[guarded success, fallthrough]`. */
function onDoneTargets(
  phaseName: string,
  onDone: unknown,
): { targets?: readonly [string, string]; defect?: string } {
  const defect = `phase "${phaseName}": \`onDone\` must be a two-arm array of \`{target}\` — [{target, guard}, {target}]`;
  if (!Array.isArray(onDone) || onDone.length !== 2) return { defect };
  const [success, trip] = onDone.map((arm) =>
    isRecord(arm) && typeof arm.target === "string" ? arm.target : undefined,
  );
  return success === undefined || trip === undefined
    ? { defect }
    : { targets: [success, trip] as const };
}

/**
 * `workflow.json` → one chart per task, plus the phase topology around them.
 *
 * WHICH HALF GUARANTEES WHAT — this matters, and it is the whole reason the
 * authored fixture (`src/chart/__fixtures__/lane.ts`) still exists beside this
 * function rather than being deleted in its favour:
 *
 *   THIS FUNCTION gives you FIDELITY. It reads bytes that only exist at
 *   runtime, so its result is `ImportedChart` — states, events and targets are
 *   `string`, and nothing about them is checked before the process starts. What
 *   it buys is that the drawing is of THE document the driver is actually
 *   folding, including a `workflow.json` this repo has never seen.
 *
 *   THE AUTHORED FIXTURE gives you TYPES. `lane.ts` is the same machine written
 *   as a literal, so `StateName`, `ResumeTargets`, `Assigns` and the totality
 *   obligation are all real there, and `assert.test-d.ts` pins them. What it
 *   cannot do is follow a document it was not written against.
 *
 * Neither replaces the other. The golden test is the seam: it asserts this
 * importer's edge set against what fabrika's own compiler produces for the same
 * file, so the runtime-typed half stays honest about the literal-typed one.
 *
 * @param document the PARSED `workflow.json` — `JSON.parse`'s output, not text.
 * @throws {WorkflowImportError} with every defect named, never a half-import.
 */
export function chartFromWorkflow(document: unknown): ImportedLane {
  const defects: string[] = [];
  const machineDef = isRecord(document) ? document.machine : undefined;
  if (!isRecord(machineDef) || !isRecord(machineDef.states)) {
    throw new WorkflowImportError([
      "document must carry a `machine.states` object",
    ]);
  }
  const documentContext = isRecord(machineDef.context)
    ? machineDef.context
    : {};
  const declaredTrigger = isRecord(document) ? document.trigger : undefined;
  if (declaredTrigger !== undefined && typeof declaredTrigger !== "string") {
    defects.push(
      "document `trigger` must be a string naming what fires this lane",
    );
  }

  const machineStates = machineDef.states;
  const charts: Record<string, ImportedChart> = {};
  const context: Record<
    string,
    {
      readonly maxRetries: number;
      readonly extras: Readonly<Record<string, unknown>>;
    }
  > = {};
  const phases: ImportedPhase[] = [];
  const gateTargets = new Set<string>();
  let terminals: { complete: string; tripped: string } | undefined;

  for (const [phaseName, node] of Object.entries(machineStates)) {
    if (nodeType(node) !== "parallel" || !isRecord(node)) continue;
    const regions = node.states;
    if (!isRecord(regions) || Object.keys(regions).length === 0) {
      defects.push(
        `phase "${phaseName}": a parallel phase must carry task regions in \`states\``,
      );
      continue;
    }
    const phaseTasks: string[] = [];
    for (const [taskId, region] of Object.entries(regions)) {
      const imported = importRegion(taskId, region);
      defects.push(...imported.defects);
      if (imported.node !== undefined) {
        const events: Record<string, { readonly scope: "edges" }> = {};
        for (const edges of Object.values(imported.node)) {
          for (const event of Object.keys(edges.on ?? {})) {
            events[event] = { scope: "edges" };
          }
        }
        // ONE group, named by the phase. The authored twin splits the same
        // states into working/parked/done, and that split is an AUTHORING
        // choice the document does not record — inventing it here would be
        // manufacturing knowledge the source does not have. It costs nothing:
        // every event is `scope: "edges"` (a lane state either routes an event
        // or refuses it), and with no broadcast scope the grouping carries no
        // obligation to carry.
        charts[taskId] = { events, states: { [phaseName]: imported.node } };
      }
      const ctx = documentContext[taskId];
      const bag = isRecord(ctx) ? ctx : {};
      const { maxRetries: rawMax, retries: _retries, ...extras } = bag;
      context[taskId] = {
        maxRetries: typeof rawMax === "number" ? rawMax : RETRY_BUDGET,
        extras,
      };
      phaseTasks.push(taskId);
    }
    phases.push({ name: phaseName, tasks: phaseTasks });

    const gate = onDoneTargets(phaseName, node.onDone);
    if (gate.defect !== undefined) defects.push(gate.defect);
    if (gate.targets !== undefined) {
      for (const target of gate.targets) {
        gateTargets.add(target);
        if (machineStates[target] === undefined) {
          defects.push(
            `phase "${phaseName}": \`onDone\` targets unknown machine-level state "${target}"`,
          );
        }
      }
      // Every phase names the same trip terminal; the LAST phase's success
      // target is the workflow's complete terminal, because earlier ones target
      // the next phase.
      terminals = { complete: gate.targets[0], tripped: gate.targets[1] };
    }
  }

  // A machine-level state the loop above did not import is a terminal or a
  // defect — never dropped silently.
  for (const [name, node] of Object.entries(machineStates)) {
    if (nodeType(node) === "parallel" && isRecord(node)) continue;
    if (nodeType(node) !== "final") {
      defects.push(
        `machine-level state "${name}" is neither a \`parallel\` phase nor a \`final\` terminal`,
      );
    } else if (!gateTargets.has(name)) {
      defects.push(
        `machine-level final "${name}" is targeted by no phase's \`onDone\` pair`,
      );
    }
  }
  if (phases.length === 0)
    defects.push("machine holds no `parallel` phase state");
  if (defects.length > 0) throw new WorkflowImportError(defects);
  if (terminals === undefined) {
    throw new WorkflowImportError([
      "no phase carried a readable `onDone` pair",
    ]);
  }

  const id =
    isRecord(document) && typeof document.id === "string"
      ? document.id
      : undefined;
  return {
    ...(id === undefined ? {} : { id }),
    ...(typeof declaredTrigger === "string"
      ? { trigger: declaredTrigger }
      : {}),
    phases,
    terminals,
    charts,
    context,
  };
}

/** Parse and import in one step — for a caller holding the document's bytes. */
export function chartFromWorkflowText(text: string): ImportedLane {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new WorkflowImportError(["the document is not JSON"]);
  }
  return chartFromWorkflow(parsed);
}

// ── reading a chart back ───────────────────────────────────────────────────

/** Every state in an imported chart, flattened out of its one phase group. */
export function statesOf(
  chart: ImportedChart,
): ReadonlyMap<string, ImportedNode> {
  const out = new Map<string, ImportedNode>();
  for (const group of Object.values(chart.states)) {
    for (const [name, node] of Object.entries(group)) out.set(name, node);
  }
  return out;
}

/** The state marked `initial: true`. */
export function initialOf(chart: ImportedChart): string {
  for (const [name, node] of statesOf(chart)) {
    if (node.initial === true) return name;
  }
  throw new Error("@demlik/tea: imported chart marks no initial state");
}

/** `true` success, `"error"` tripped, `false` not a final — the ONE polarity read. */
export function endPolarityOf(
  node: ImportedNode | undefined,
): true | "error" | false {
  if (node?.end === undefined) return false;
  return node.end;
}
