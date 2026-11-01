// ---------------------------------------------------------------------------
// `MsgTally` — what a property run's lists did, per Msg type.
//
// A property holds whether or not its lists reach anything, so a change can cut a
// whole path with every law still true. The tally counts how often each Msg type
// was drawn and how often it acted, so a run can say what it never reached.
//
// fast-check re-runs the property while it shrinks, so the tally closes at the
// first failure: past that point the lists are shrink attempts, not lists the run
// drew, and `numRuns` does not count them either.
// ---------------------------------------------------------------------------

import { type Cmd, structuralHash } from "../../index";
import type { Step } from "./replay-fold";

/** What a property run's lists did with one Msg type. */
export interface MsgCount {
  /** How many of this Msg type the run's lists held. */
  readonly drawn: number;
  /**
   * How many of those acted: the step's `next` differs from its `prev` by
   * `structuralHash`, or the step sent a Cmd.
   */
  readonly acted: number;
}

/**
 * What `structuralHash` renders a value to, with a list or plain object cut at its
 * opening bracket. No other rendering is a lone bracket, since a string is quoted,
 * and anything that isn't plain data throws here with `structuralHash`'s own words.
 */
function outline(value: unknown): string {
  if (Array.isArray(value)) return "[";
  if (typeof value === "object" && value !== null) {
    const proto = Object.getPrototypeOf(value) as object | null;
    if (proto === Object.prototype || proto === null) return "{";
  }
  return structuralHash(value);
}

/**
 * Whether two values would differ by `structuralHash`, without building either
 * string. It stops at the first difference and never looks inside one object
 * reached from both sides, which is what keeps a `{ ...prev, n }` cheap however
 * much it shares with `prev`.
 */
function differs(a: unknown, b: unknown): boolean {
  if (a === b) return false;
  const shape = outline(a);
  if (shape !== outline(b)) return true;
  if (shape === "[") return listsDiffer(a as unknown[], b as unknown[]);
  if (shape === "{") {
    return recordsDiffer(
      a as Record<string, unknown>,
      b as Record<string, unknown>,
    );
  }
  return false;
}

/** A hole renders as nothing, so a list that is one hole reads as an empty list. */
const slotsOf = (list: readonly unknown[]): readonly unknown[] =>
  list.length === 1 && !(0 in list) ? [] : list;

function listsDiffer(a: readonly unknown[], b: readonly unknown[]): boolean {
  const left = slotsOf(a);
  const right = slotsOf(b);
  if (left.length !== right.length) return true;
  for (let i = 0; i < left.length; i++) {
    if (i in left !== i in right || differs(left[i], right[i])) return true;
  }
  return false;
}

/** A key the hash can't see reads as absent, and an absent key reads as `undefined`. */
const seenAt = (record: Record<string, unknown>, key: string): unknown =>
  Object.prototype.propertyIsEnumerable.call(record, key)
    ? record[key]
    : undefined;

function recordsDiffer(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (differs(seenAt(a, key), seenAt(b, key))) return true;
  }
  return false;
}

/** The two ways a step acts. A cell that returns an equal new object does neither. */
function classify<S, M, C extends Cmd>(
  step: Step<S, M, C>,
): { readonly acted: boolean; readonly refusal: unknown } {
  if (step.cmds.length > 0) return { acted: true, refusal: null };
  try {
    return { acted: differs(step.prev, step.next), refusal: null };
  } catch (refusal) {
    return { acted: true, refusal };
  }
}

export class MsgTally {
  readonly #counts = new Map<string, MsgCount>();
  #closed = false;
  #refusal: unknown = null;

  /** @param msgTypes The machine's Msg types, so one never drawn still reads zero. */
  constructor(msgTypes: readonly string[]) {
    for (const type of msgTypes) this.#counts.set(type, { drawn: 0, acted: 0 });
  }

  /** Count one list's steps, unless the run has already failed. */
  add<S, M extends { type: string }, C extends Cmd>(
    steps: readonly Step<S, M, C>[],
  ): void {
    if (this.#closed) return;
    for (const step of steps) {
      const { acted, refusal } = classify(step);
      const count = this.#counts.get(step.msg.type) ?? { drawn: 0, acted: 0 };
      this.#counts.set(step.msg.type, {
        drawn: count.drawn + 1,
        acted: count.acted + (acted ? 1 : 0),
      });
      this.#refusal ??= refusal;
    }
  }

  /** The run has failed. Whatever comes next is shrinking. */
  close(): void {
    this.#closed = true;
  }

  /** Each Msg type's count: the machine's types first, then any other drawn. */
  get counts(): ReadonlyMap<string, MsgCount> {
    return new Map(this.#counts);
  }

  /**
   * What `structuralHash` threw on the first value the comparison reached and
   * couldn't read. Such a step counts as acted, since nothing shows it didn't, so
   * "never acted" can't be trusted here.
   */
  get refusal(): unknown {
    return this.#refusal;
  }

  /** The Msg types at zero acted, each with what it drew. */
  get neverActed(): readonly (readonly [string, MsgCount])[] {
    return [...this.#counts].filter(([, count]) => count.acted === 0);
  }
}
