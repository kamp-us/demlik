/**
 * @demlik/tea/agent — the closure-free PURE reducer helpers.
 *
 * NOT part of the public `./agent` barrel: these are the reducer core's pure
 * conversation / state operations, factored OUT of the `createAgent` closure so
 * the factory module holds only the verbs that genuinely close over the composed
 * bricks (`run` / `llm` / `fan` / `compactRc` / `config`). Each function here is
 * pure and generic over the same `Stage / P / O / R` params the closure fixes,
 * so the call sites inside `createAgent` read identically (TS infers the params
 * from the state argument). The barrel `index.ts` never re-exports this file, so
 * everything stays internal.
 */

import type { LlmRunCmd } from "../internal/llm-call";
import { MsgType } from "../protocol";
import type { AgentCompactRunCmd, CompactionPurpose } from "./compaction";
import { COMPACTION_PURPOSE } from "./compaction";
import type {
  AgentState,
  AgentTurn,
  Awaiting,
  Conversation,
  ToolCall,
  TurnUsage,
} from "./types";

/** The narrowed `awaiting` variant for a given `kind`. */
export type AwaitingOf<K extends Awaiting["kind"]> = Extract<
  Awaiting,
  { kind: K }
>;

/** The running total before any turn has reported usage. */
export const NO_USAGE: TurnUsage = { inputTokens: 0, outputTokens: 0 };

/**
 * A fresh conversation entering the agentic loop — awaiting the first brain
 * call. `usage` is the run's total so far: zero at `agent_start`, the previous
 * stage's total when a stage advance seeds the next one (#332).
 */
export function freshConversation<R>(
  usage: TurnUsage = NO_USAGE,
): Conversation<R> {
  return {
    turns: [],
    toolRecords: [],
    turnCount: 0,
    awaiting: { kind: "llm" },
    usage,
    contextTokens: null,
  };
}

/**
 * Sum two usage readings field by field. An optional count rides the sum only
 * when at least one side reported it, so a provider that never reports
 * reasoning tokens never grows a `reasoningTokens: 0`. PURE.
 */
export function addUsage(total: TurnUsage, turn: TurnUsage): TurnUsage {
  const optional = (key: "reasoningTokens" | "cachedInputTokens") =>
    total[key] === undefined && turn[key] === undefined
      ? {}
      : { [key]: (total[key] ?? 0) + (turn[key] ?? 0) };
  return {
    inputTokens: total.inputTokens + turn.inputTokens,
    outputTokens: total.outputTokens + turn.outputTokens,
    ...optional("reasoningTokens"),
    ...optional("cachedInputTokens"),
  };
}

/**
 * Fold one settled brain turn's usage into the conversation's two readings: add
 * it to the running total, and make it the latest context size. A turn that
 * reported none leaves the total alone and CLEARS the context size — the size
 * the previous turn reported no longer describes the transcript, and a stale
 * reading is exactly what must never fire a size-based fold. PURE.
 */
export function withTurnUsage<R>(
  conv: Conversation<R>,
  turn: AgentTurn,
): Conversation<R> {
  const { usage } = turn;
  if (usage === undefined) return { ...conv, contextTokens: null };
  return {
    ...conv,
    usage: addUsage(conv.usage, usage),
    contextTokens: usage.inputTokens + usage.outputTokens,
  };
}

/**
 * Fill in the usage readings a conversation persisted before #332 lacks — a
 * zero total and no context size. The rehydration guard `agent_boot` runs, so
 * a 0.17.x Model resumes with its total starting from zero rather than a
 * `stopWhen` reading `undefined`. Identity on a conversation that has them.
 * PURE.
 */
export function withUsageDefaults<R>(conv: Conversation<R>): Conversation<R> {
  const persisted = conv as Partial<Conversation<R>>;
  if (persisted.usage !== undefined && persisted.contextTokens !== undefined) {
    return conv;
  }
  return {
    ...conv,
    usage: persisted.usage ?? NO_USAGE,
    contextTokens: persisted.contextTokens ?? null,
  };
}

/**
 * Collapse a turn's tool calls to one per `callId` (first occurrence wins).
 * `callId` is the fan-out identity (`idOf`); duplicates in one batch are a
 * model defect that, un-deduped, would double-execute the tool and wedge the
 * batch (one settle Msg cannot close two same-id `running` entries). PURE —
 * preserves order, allocates no Error.
 */
export function dedupeByCallId(
  calls: readonly ToolCall[],
): readonly ToolCall[] {
  const seen = new Set<string>();
  const out: ToolCall[] = [];
  for (const call of calls) {
    if (seen.has(call.callId)) continue;
    seen.add(call.callId);
    out.push(call);
  }
  return out;
}

/**
 * Fold the oldest `folding` turns of a conversation into a single synthetic
 * `summaryTurn` (#85, design A1) — PURE. The summary becomes the new head turn
 * (index 0); the surviving turns (`turns.slice(folding)`) follow. Every tool
 * record whose producing turn was folded (`turn < folding`) is DROPPED; each
 * survivor's `turn` is RE-INDEXED by `-folding + 1` so it still equals the new
 * index in `turns` of its producing turn (the summary occupies one slot where
 * `folding` turns stood, so survivors shift left by `folding` then right by 1).
 * `turnCount` is UNCHANGED — compaction is not a model round-trip (decision C).
 *
 * The usage total is UNCHANGED too: the folded turns were still paid for. The
 * context size is CLEARED, because it measured the transcript before the fold;
 * left standing it would fire a size-based fold again before the next brain
 * turn could report what the shrunk transcript costs (#332).
 *
 * Caller guarantees `2 <= folding <= turns.length` (the trigger clamps + skips
 * `< 2`), so the result is strictly shorter (`length - folding + 1`).
 */
export function foldSummary<R>(
  conv: Conversation<R>,
  folding: number,
  summaryTurn: AgentTurn,
): Conversation<R> {
  const shift = folding - 1; // survivors move left by this many slots.
  const survivingTurns = conv.turns.slice(folding);
  const survivingRecords = conv.toolRecords
    .filter((rec) => rec.turn >= folding)
    .map((rec) => ({ ...rec, turn: rec.turn - shift }));
  return {
    ...conv,
    turns: [summaryTurn, ...survivingTurns],
    toolRecords: survivingRecords,
    awaiting: { kind: "llm" },
    contextTokens: null,
  };
}

/** The current pipeline stage value (`undefined` for a single-shot run). */
export function currentStage<
  Stage,
  P extends string,
  O extends Record<P, unknown>,
  R,
>(s: AgentState<Stage, P, O, R>): Stage | undefined {
  return s.run.stepStates.find((i) => i.status === "running")?.input;
}

/**
 * True iff the run is in a terminal state (monitored-run done/failed/cancelled,
 * or agent failure). Every verb gates on this, so `cancelled` belonging here is
 * what makes an abort stop the loop: past it, a settling tool or brain call
 * folds to a no-op and emits nothing.
 */
export function isSettled<
  Stage,
  P extends string,
  O extends Record<P, unknown>,
  R,
>(s: AgentState<Stage, P, O, R>): boolean {
  return (
    s.run.phase === "done" ||
    s.run.phase === "failed" ||
    s.run.phase === "cancelled" ||
    s.failure !== null
  );
}

/**
 * The stale-settle guard shared by the awaiting-scoped verbs (`turn` /
 * `settleTool` / `compactOk` / `compactErr`): return the live conversation
 * ALREADY narrowed to the given `awaiting.kind`, or `null` when the verb must
 * no-op — the run is settled, there is no conversation, or it is awaiting
 * something else (a stale settle after boot / advance). Collapses the
 * `isSettled → conv === null → awaiting.kind` triple that recurred verbatim
 * across the four verbs; each caller supplies its own no-op return. PURE.
 */
export function requireAwaiting<
  Stage,
  P extends string,
  O extends Record<P, unknown>,
  R,
  K extends Awaiting["kind"],
>(
  s: AgentState<Stage, P, O, R>,
  kind: K,
): (Conversation<R> & { readonly awaiting: AwaitingOf<K> }) | null {
  if (isSettled(s)) return null;
  const conv = s.conversation;
  if (conv === null || conv.awaiting.kind !== kind) return null;
  return conv as Conversation<R> & { readonly awaiting: AwaitingOf<K> };
}

/** Re-key a composed compaction `resilient_run` Cmd to the dedicated `compact_run`. */
export function toCompactRunCmd(
  cmd: LlmRunCmd<CompactionPurpose>,
): AgentCompactRunCmd {
  return {
    type: MsgType.CompactRun,
    key: COMPACTION_PURPOSE,
    input: cmd.input,
  };
}
