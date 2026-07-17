/**
 * @demlik/tea/machine-viz — turn a `Machine` into a Mermaid diagram string.
 *
 * PURE. No deps, no AST parsing, no file I/O. The function reads only the
 * `Machine` value it is handed plus optional sample states/msgs/ctx.
 *
 * The trick: TEA update cells are PURE (invariant 2 — they return
 * `[nextState, cmds]` as data, no effects). So we can SAFELY EXECUTE a cell to
 * discover its target state — exactly what `replay` does. That gives us REAL
 * edges (`red --> green : go`) without parsing source. When no sample is
 * provided for a `(state, msg)` pair we cannot resolve the target, so we fall
 * back to a STRUCTURAL self-edge annotated with `?` — visually distinct from a
 * resolved edge and documented in the diagram's legend.
 *
 * Form detection is `formOf(machine)` — the same reader `run`/`replay` use,
 * honoring the authoritative `__form` tag `defineMachine` stamps (falling back
 * to the structural heuristic for machines built without it; #275).
 *
 * What we MUST NOT do (these are the effectful paths, off-limits here):
 *   - call `interpret[*]` handlers (perform I/O)
 *   - call `subscribe[*]` handlers (install listeners)
 *   - call `run` / the runtime
 * We MAY call `init`, `update[*]` cells, and `subscriptions(state)` — all pure
 * by the invariants (same set `replay` is allowed to touch).
 */

import type { Cmd, Machine, Sub } from "../index";
import { formOf } from "../index";

// === Public options ===

/**
 * Options controlling diagram emission.
 *
 * `samples` is the lever that turns STRUCTURAL edges into RESOLVED edges. For a
 * Transitions machine, providing a sample state for `stateType` AND a sample
 * msg for `msgType` lets us execute `update[stateType][msgType](state, msg)` and
 * read the real target `next.type`. Sample maps are keyed by the discriminant
 * string (`state.type` / `msg.type`).
 *
 * `samples.ctx` is the argument to `init(null, ctx)` — provide it to draw the
 * `[*] -->` initial-state edge. Omitted ⇒ no init edge (annotated as such),
 * because `init`'s signature requires a ctx and we will not invent one.
 */
export interface MachineVizOptions<S, M> {
  samples?: {
    /** Sample state per `state.type` — unlocks RESOLVED edges + sub annotations. */
    states?: Partial<Record<string, S>>;
    /** Sample msg per `msg.type` — unlocks RESOLVED edges. */
    msgs?: Partial<Record<string, M>>;
    /** Ctx for `init(null, ctx)` — unlocks the `[*] -->` initial-state edge. */
    ctx?: unknown;
  };
  /** Mermaid layout direction. Default `"TB"` (top-to-bottom). */
  direction?: "TB" | "LR";
  /** Optional diagram title, emitted as a Mermaid front-matter `title:` block. */
  title?: string;
}

// === Mermaid label escaping ===
//
// Mermaid state ids must be identifier-safe; arbitrary `type` strings (which
// CAN contain `:`, spaces, `-`, etc.) are not. We sanitize the id used as the
// node identifier and carry the human-readable original as a quoted label via
// `stateId : "Original"` when they differ. Edge transition labels (after the
// `:`) are sanitized to avoid breaking the arrow syntax.

/** Sanitize a discriminant string into a Mermaid-safe node identifier. */
function safeId(raw: string): string {
  // Replace any run of non-identifier chars with `_`; prefix a leading digit so
  // the id is always a valid Mermaid token. Empty ⇒ a stable placeholder.
  const cleaned = raw.replace(/[^A-Za-z0-9_]/g, "_");
  if (cleaned === "") return "_empty";
  return /^[0-9]/.test(cleaned) ? `s_${cleaned}` : cleaned;
}

/** Sanitize text used as a Mermaid edge/transition label (after the `:`). */
function safeLabel(raw: string): string {
  // Strip the chars that terminate or confuse a transition label: newlines,
  // the `:` that separates label from target, and Mermaid's `"`/`;` delimiters.
  return raw.replace(/["\n\r;:]/g, " ").trim();
}

// === Edge model ===

type Edge =
  // Resolved: we executed the cell with samples and read the real target.
  | { kind: "resolved"; from: string; to: string; msg: string }
  // Structural: no samples for the pair → target unknown, drawn as a self-loop.
  | { kind: "structural"; from: string; msg: string };

// === toMermaid ===

/**
 * Render a `Machine` as a Mermaid `stateDiagram-v2` string.
 *
 * - **Transitions form** (`update` is a record-of-records): nodes are the
 *   `state.type` keys; each `(stateType × msgType)` cell becomes an edge. With
 *   samples for both, the edge is RESOLVED by executing the (pure) cell. Without
 *   samples it is STRUCTURAL — a `from --> from : msg?` self-loop (the `?`
 *   suffix marks "target unresolved"). A legend note documents the distinction.
 *   The `[*] -->` init edge is drawn only when `samples.ctx` is provided.
 *
 * - **Reducer form** (`update` values are functions): there is no static phase
 *   graph (state is not a discriminated union over phases). We emit a single
 *   node listing the handled `msg.type`s and an honest note saying so. No edges
 *   are invented.
 *
 * Output is deterministic for the same input (keys iterated in insertion order,
 * no clocks, no randomness).
 */
export function toMermaid<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
>(
  machine: Machine<S, M, C, U, Ctx>,
  // `NoInfer` pins S/M to the `machine` argument so sample object literals in
  // `opts` are CHECKED against the machine's State/Msg unions rather than
  // driving inference (which would widen `{ type: "open" }` to `{ type: string }`
  // and collide with the machine's discriminated union).
  opts: MachineVizOptions<NoInfer<S>, NoInfer<M>> = {},
): string {
  const direction = opts.direction ?? "TB";
  const stateSamples = opts.samples?.states ?? {};
  const msgSamples = opts.samples?.msgs ?? {};
  const hasCtx = opts.samples !== undefined && "ctx" in opts.samples;

  const mode = formOf(machine);
  const lines: string[] = [];

  // Front matter — Mermaid reads a YAML `title:` block before the diagram.
  if (opts.title !== undefined) {
    lines.push("---", `title: ${opts.title}`, "---");
  }
  lines.push("stateDiagram-v2");
  lines.push(`  direction ${direction}`);

  if (mode === "reducer") {
    emitReducer(machine, lines);
  } else {
    emitTransitions(machine, lines, {
      stateSamples,
      msgSamples,
      hasCtx,
      ctx: opts.samples?.ctx,
    });
  }

  // Subscriptions annotation — pure call to `subscriptions(sampleState)` per
  // sampled state. Skipped entirely when no state samples are provided (we
  // refuse to invent a state to feed it).
  emitSubscriptions(machine, lines, stateSamples);

  return lines.join("\n");
}

// === Reducer-form emission ===

/**
 * Reducer form has no phase graph. Emit one node listing the handled msg types
 * plus an honest note. The msg set is the `update` record's keys (the Reducer
 * mapped type guarantees one cell per Msg variant).
 */
function emitReducer(machine: { update: unknown }, lines: string[]): void {
  const msgTypes = Object.keys(machine.update as object);
  lines.push("  state ReducerMachine {");
  if (msgTypes.length === 0) {
    lines.push("    [*] --> NoMsgs");
    lines.push('    NoMsgs : "(no msg variants — M is never)"');
  } else {
    for (const m of msgTypes) {
      lines.push(`    ${safeId(m)} : ${safeLabel(m)}`);
    }
  }
  lines.push("  }");
  // The note IS the design honesty: no edges, because reducer-form state is not
  // a discriminated union over phases — there is no static target to draw.
  lines.push("  note right of ReducerMachine");
  lines.push("    Reducer-form machine: flat dispatch keyed by msg.type.");
  lines.push(
    "    No phase graph — state is not a discriminated union over phases.",
  );
  lines.push(`    Handled msg types: ${msgTypes.length}`);
  lines.push("  end note");
}

// === Transitions-form emission ===

interface TransitionsCtx<S, M> {
  stateSamples: Partial<Record<string, S>>;
  msgSamples: Partial<Record<string, M>>;
  hasCtx: boolean;
  ctx: unknown;
}

/**
 * Transitions form: walk the `update[stateType][msgType]` table. Execute the
 * (pure) cell when both samples exist → RESOLVED edge; otherwise → STRUCTURAL
 * self-loop. Draw the `[*] -->` init edge only when a ctx sample is given.
 */
function emitTransitions<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
>(
  machine: Machine<S, M, C, U, Ctx>,
  lines: string[],
  ctx: TransitionsCtx<S, M>,
): void {
  type CellFn = (state: S, msg: M) => readonly [S, readonly C[]];
  type Table = Record<string, Record<string, CellFn>>;
  const table = machine.update as unknown as Table;
  const stateTypes = Object.keys(table);

  // Declare every node up front so even unreachable phases render.
  for (const st of stateTypes) {
    lines.push(`  ${safeId(st)}`);
  }

  // Init edge — only resolvable with a ctx sample. `init(null, ctx)` is pure
  // (invariant 2: fresh-boot branch returns a starting state). Read `next.type`.
  if (ctx.hasCtx) {
    const [initState] = machine.init(null, ctx.ctx as Ctx);
    const initType = (initState as unknown as { type: string }).type;
    lines.push(`  [*] --> ${safeId(initType)}`);
  } else {
    lines.push(
      "  %% init edge omitted: no samples.ctx provided to run init(null, ctx)",
    );
  }

  let anyStructural = false;
  for (const st of stateTypes) {
    const row = table[st];
    if (row === undefined) continue;
    const msgTypes = Object.keys(row);
    for (const mt of msgTypes) {
      const edge = resolveEdge(row, st, mt, ctx);
      if (edge.kind === "resolved") {
        lines.push(
          `  ${safeId(edge.from)} --> ${safeId(edge.to)} : ${safeLabel(edge.msg)}`,
        );
      } else {
        anyStructural = true;
        // Structural self-loop with a `?` suffix — target unresolved. Visually
        // distinct from a resolved edge (self-loop + trailing `?`).
        lines.push(
          `  ${safeId(edge.from)} --> ${safeId(edge.from)} : ${safeLabel(edge.msg)}?`,
        );
      }
    }
  }

  // Legend — document the resolved-vs-structural distinction in the output.
  lines.push(`  note right of ${safeId(stateTypes[0] ?? "_empty")}`);
  lines.push("    Transitions-form machine.");
  lines.push("    Edge a --> b : msg = RESOLVED (cell executed with samples).");
  if (anyStructural) {
    lines.push(
      "    Self-loop a --> a : msg? = STRUCTURAL (no sample; target unresolved).",
    );
  }
  lines.push("  end note");
}

/**
 * Resolve a single `(stateType, msgType)` cell into an Edge. With both a sample
 * state and a sample msg, EXECUTE the pure cell to read the real target. Any
 * missing sample → structural. A thrown cell (e.g. a sample shaped wrong for
 * the cell) degrades to structural rather than crashing the whole diagram —
 * the diagram is a best-effort visualization, not a correctness gate.
 */
function resolveEdge<S, M extends { type: string }, C extends Cmd>(
  row: Record<string, (state: S, msg: M) => readonly [S, readonly C[]]>,
  stateType: string,
  msgType: string,
  ctx: {
    stateSamples: Partial<Record<string, S>>;
    msgSamples: Partial<Record<string, M>>;
  },
): Edge {
  const sampleState = ctx.stateSamples[stateType];
  const sampleMsg = ctx.msgSamples[msgType];
  const cell = row[msgType];
  if (
    sampleState === undefined ||
    sampleMsg === undefined ||
    cell === undefined
  ) {
    return { kind: "structural", from: stateType, msg: msgType };
  }
  try {
    const [next] = cell(sampleState, sampleMsg);
    const to = (next as unknown as { type: string }).type;
    return { kind: "resolved", from: stateType, to, msg: msgType };
  } catch {
    // Mismatched sample → cannot resolve. Fall back to structural.
    return { kind: "structural", from: stateType, msg: msgType };
  }
}

// === Subscriptions annotation ===

/**
 * For each sampled state, call the (pure) `subscriptions(state)` description
 * function and annotate which Sub types are active in that state as a Mermaid
 * note. We call `subscriptions` (the description) but NEVER `subscribe[*]` (the
 * effectful installer) — same boundary `replay` honors. Skipped when no state
 * samples are provided or the machine declares no `subscriptions`.
 */
function emitSubscriptions<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
>(
  machine: Machine<S, M, C, U, Ctx>,
  lines: string[],
  stateSamples: Partial<Record<string, S>>,
): void {
  if (machine.subscriptions === undefined) return;
  const stateTypes = Object.keys(stateSamples);
  if (stateTypes.length === 0) return;

  for (const st of stateTypes) {
    const sample = stateSamples[st];
    if (sample === undefined) continue;
    const subs = machine.subscriptions(sample);
    const subTypes = subs.map((s) => s.type);
    const body =
      subTypes.length === 0
        ? "(no active subs)"
        : `subs: ${subTypes.map(safeLabel).join(", ")}`;
    lines.push(`  note left of ${safeId(st)}`);
    lines.push(`    ${body}`);
    lines.push("  end note");
  }
}
