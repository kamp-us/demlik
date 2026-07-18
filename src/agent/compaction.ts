/**
 * @demlik/tea/agent — the context-compaction seam (#85).
 *
 * The opt-in transcript snapshot-and-compact policy, shaped exactly like
 * `AgentSnapshotConfig` (see `./types`) so a short agent pays nothing and cannot
 * even mention the machinery. This module owns the whole `$compact` vocabulary:
 * the reserved purpose, the summary schema, the consumer policy, the config
 * discriminant, and the dedicated `compact_run` / `compact_ok` / `compact_err`
 * Cmd + Msgs re-keyed off the composed resilient call at the agent boundary.
 */

import type { Cmd, Interpret } from "../index";
import type {
  LlmCall,
  LlmErr,
  LlmOk,
  MessageLoader,
  Schema,
} from "../llm-call";
import type { MsgType } from "../protocol";
import { schemaFromGuard } from "./schema";
import type { Conversation } from "./types";

/**
 * The reserved purpose the compaction round-trip runs under (#85). Compaction
 * is a DEDICATED resilient LLM call (design B1), NOT one of the consumer's brain
 * purposes `P` — so it carries its own purpose literal, kept in the agent's
 * private `$`-namespace (the same reserved-namespace discipline `with-resilience`
 * uses) so it never collides with a consumer purpose. A consumer never names it.
 */
export type CompactionPurpose = "$compact";

/** The reserved compaction purpose's value — the single in-flight summarize call's key. */
export const COMPACTION_PURPOSE: CompactionPurpose = "$compact";

/**
 * The purpose→output map for the compaction LLM call — the single reserved
 * `$compact` purpose mapping to a {@link CompactionSummary}. Mirrors the brain
 * call's `O` map, scoped to the one compaction purpose, so the composed
 * `createLlmCall` parses the summarize output under the same structured-output
 * contract the brain call uses.
 */
export interface CompactionOutputs extends Record<CompactionPurpose, unknown> {
  readonly $compact: CompactionSummary;
}

/**
 * Narrow an unknown to a {@link CompactionSummary} — the runtime witness for the
 * compaction call's structured output. Checks the one load-bearing field
 * (`summary` is a string). PURE — allocates no Error.
 */
export function isCompactionSummary(
  value: unknown,
): value is CompactionSummary {
  if (value === null || typeof value !== "object") return false;
  return typeof (value as { summary?: unknown }).summary === "string";
}

/**
 * The `Schema<CompactionSummary>` the compaction call binds — tea's own parse
 * target for the summarize round-trip (it OWNS the `$compact` purpose's output).
 * Throws on a non-summary (the zod-style `parse` contract the llm-call handler
 * relies on), so a malformed summary is a `compact_err` (errors are data), never
 * a corrupt fold-back.
 */
export const compactionSummarySchema: Schema<CompactionSummary> =
  schemaFromGuard(isCompactionSummary, "a CompactionSummary");

/**
 * The result a compaction round-trip produces — the model's summary of the
 * folded-away turns. Tea OWNS this shape (the `$compact` purpose's output): the
 * fold-back (`compact_ok`) writes `summary` into a synthetic head `AgentTurn`
 * (design A1), so a consumer's `loadMessages` reads it as a normal turn with no
 * watermark to learn. Generic-free — the summary is always plain text.
 */
export interface CompactionSummary {
  /** The model's summary of the folded-away (oldest) turns + their tool records. */
  readonly summary: string;
}

/**
 * The consumer's compaction policy (#85). One PURE trigger; the impure
 * summarize round-trip is composed by the agent (a dedicated resilient LLM call
 * under the reserved `$compact` purpose, inheriting retry/backoff — design B1),
 * so the policy never reaches the model itself.
 *
 *   - `planCompaction` — PURE: given the live conversation ABOUT to fire a brain
 *     call, return how many of the OLDEST turns to fold into a summary, or `0`
 *     to skip. No clock, no RNG → replay re-decides identically (design D). A
 *     char-length / turn-count / real deterministic-tokenizer heuristic all
 *     qualify. Returning `>= turns.length` is clamped to "fold all but keep the
 *     loop alive" by the trigger (it never folds the turn currently in flight).
 *   - `payloadOf` — build the per-call prompt payload the compaction
 *     `MessageLoader` reads (the turns being folded). Omit → `null` (the loader,
 *     if any, reads the conversation off the agent's own state). Opaque to the
 *     agent, exactly like the brain call's `payloadOf`.
 */
export interface CompactionPolicy<R, Msg = unknown> {
  /** PURE trigger: how many OLDEST turns to fold (`0` = skip). No clock/RNG. */
  readonly planCompaction: (conversation: Conversation<R>) => number;
  /** Build the summarize call's prompt payload from the turns being folded. Omit → `null`. */
  readonly payloadOf?: (
    conversation: Conversation<R>,
    folding: number,
  ) => unknown;
  /** DI port — the SDK / message loader for the summarize call. Omit → invoke with `[]`. */
  readonly loadMessages?: MessageLoader<CompactionPurpose, Msg>;
}

/**
 * The compaction discriminant (#85), shaped exactly like {@link
 * AgentSnapshotConfig}. Compaction is either OFF —
 * `compaction` is structurally absent and the agent never emits a `compact_run`
 * Cmd — or ON, in which case `compaction` is a {@link CompactionPolicy}. A `{
 * compaction?: never }` member (rather than a bare optional) makes the OFF case
 * load-bearing: it forbids passing `compaction` at all, so `toMachine`
 * config-derives whether the `compact_run` interpret cell is REQUIRED (ON) or
 * FORBIDDEN (OFF) — never a silent no-op cell, the #55 type-lie-killer reused.
 */
export type AgentCompactionConfig<R, Msg> =
  | { readonly compaction?: never }
  | { readonly compaction: CompactionPolicy<R, Msg> };

/**
 * The "summarize the oldest N turns" effect Cmd — the compaction round-trip's
 * carrier (#85). It mirrors the brain `resilient_run` Cmd's shape (a `key` + the
 * plain `LlmCall<CompactionPurpose>` input, no closures) but under the dedicated
 * `compact_run` discriminant so it routes to the compaction interpret cell, not
 * the brain one. The cell composes the resilient brick (retry/backoff) and
 * returns the re-keyed `compact_ok` / `compact_err` settle for re-entry.
 */
export type AgentCompactRunCmd = Cmd<typeof MsgType.CompactRun> & {
  readonly key: CompactionPurpose;
  readonly input: LlmCall<CompactionPurpose>;
};

/** The compaction round-trip success settle Msg — carries the parsed {@link CompactionSummary}. */
export type AgentCompactOkMsg = {
  readonly type: typeof MsgType.CompactOk;
  readonly key: CompactionPurpose;
  readonly result: LlmOk<CompactionPurpose, CompactionOutputs>;
  readonly at: number;
};

/** The compaction round-trip failure settle Msg — carries the typed {@link LlmErr}. */
export type AgentCompactErrMsg = {
  readonly type: typeof MsgType.CompactErr;
  readonly key: CompactionPurpose;
  readonly error: LlmErr<CompactionPurpose>;
  readonly at: number;
};

/**
 * The CONFIG-DERIVED compaction obligation on `toMachine`'s `toolInterpret`
 * (#85), the exact twin of {@link SnapshotInterpret}.
 * Resolves on the `Compact` discriminant the compaction overload of
 * `createAgent` fixes:
 *
 *   - compaction ON  → a REQUIRED `compact_run` cell
 *     (`Interpret<M, AgentCompactRunCmd, Ctx>`). The summarize round-trip MUST be
 *     wired — the agent never defaults it to a no-op.
 *   - compaction OFF → `{ compact_run?: never }`. The cell is FORBIDDEN: with no
 *     policy the agent never emits a `compact_run` Cmd, so wiring it would be
 *     dead code. The consumer cannot even mention `compact_run`.
 *
 * Same type-lie-killer as the snapshot derivation: the obligation is present
 * EXACTLY when the Cmd can fire, never as a silent gap the agent backfills.
 */
export type CompactInterpret<
  M extends { type: string },
  Compact extends boolean,
  Ctx,
> = Compact extends true
  ? Interpret<M, AgentCompactRunCmd, Ctx>
  : { readonly compact_run?: never };
