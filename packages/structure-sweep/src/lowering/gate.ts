import type { JevState } from "@demlik/tea/jev";
import type { Asker, Judgement } from "./ask.js";
import type { DerivedFloor } from "./calibration.js";
import { type Fact, type SourceSpan, unknownValue } from "./fact.js";

declare const validPolicy: unique symbol;

/**
 * The gate's rule for one stage: the floor an answer must reach, and how many enrichment rounds a
 * below-floor item gets before it abstains. Built only by `gatePolicy`, whose floor comes from the
 * stage's calibration, so no gate runs on a floor its gold set did not earn.
 */
export interface GatePolicy {
  readonly floor: number;
  readonly maxRounds: number;
  readonly [validPolicy]: true;
}

/**
 * One stage's policy from its calibration. Only a `derived` calibration is accepted: a stage whose
 * floor is `unreachable` has nothing the gate could promote, so it has no policy to build.
 */
export function gatePolicy(policy: {
  readonly calibration: DerivedFloor;
  readonly maxRounds: number;
}): GatePolicy {
  if (!Number.isInteger(policy.maxRounds) || policy.maxRounds < 0)
    throw new RangeError(
      `maxRounds is a whole number of rounds, not ${policy.maxRounds}`,
    );
  return {
    floor: policy.calibration.floor,
    maxRounds: policy.maxRounds,
  } as GatePolicy;
}

/**
 * What the gate makes of one answer. `round` counts enrichments: 0 is the first ask. `retrying`
 * names the enrichment round about to run.
 */
export type GateOutcome<
  K extends string,
  J extends Judgement<K> = Judgement<K>,
> =
  | {
      readonly _tag: "promoted";
      readonly judgement: J;
      readonly round: number;
    }
  | {
      readonly _tag: "retrying";
      readonly judgement: J;
      readonly round: number;
    }
  | {
      readonly _tag: "abstained";
      readonly judgement: J;
      readonly rounds: number;
    };

export type Retrying<
  K extends string,
  J extends Judgement<K> = Judgement<K>,
> = Extract<GateOutcome<K, J>, { _tag: "retrying" }>;

/** Where an item comes to rest: the gate never hands back an item still retrying. */
export type Settled<
  K extends string,
  J extends Judgement<K> = Judgement<K>,
> = Exclude<GateOutcome<K, J>, { _tag: "retrying" }>;

/** The pure decision: at or above the floor promotes; below it retries until `maxRounds`, then abstains. */
export function decide<K extends string, J extends Judgement<K>>(
  policy: GatePolicy,
  round: number,
  judgement: J,
): GateOutcome<K, J> {
  if (judgement.confidence >= policy.floor)
    return { _tag: "promoted", judgement, round };
  if (round < policy.maxRounds)
    return { _tag: "retrying", judgement, round: round + 1 };
  return { _tag: "abstained", judgement, rounds: round };
}

export interface GateItem {
  readonly id: string;
  readonly span: SourceSpan;
  readonly state: JevState;
}

/** Add context to a below-floor item — callee bodies, call sites, the data it reads — for the next ask. */
export type Enrich<K extends string, J extends Judgement<K> = Judgement<K>> = (
  item: GateItem,
  state: JevState,
  retrying: Retrying<K, J>,
) => Promise<JevState>;

export interface GateOptions<
  K extends string,
  J extends Judgement<K> = Judgement<K>,
> {
  readonly policy: GatePolicy;
  readonly ask: Asker<K, J>;
  readonly enrich: Enrich<K, J>;
}

/** Ask, then enrich and re-ask while the gate says retry, until the item is promoted or abstains. */
export async function gate<
  K extends string,
  J extends Judgement<K> = Judgement<K>,
>(item: GateItem, options: GateOptions<K, J>): Promise<Settled<K, J>> {
  let state = item.state;
  let round = 0;
  for (;;) {
    const outcome = decide<K, J>(
      options.policy,
      round,
      await options.ask(state),
    );
    if (outcome._tag !== "retrying") return outcome;
    state = await options.enrich(item, state, outcome);
    round = outcome.round;
  }
}

/** A settled item as the next stage reads it: a promoted answer is known, an abstained one unknown. */
export function factOf<K extends string, J extends Judgement<K>>(
  item: GateItem,
  settled: Settled<K, J>,
  policy: GatePolicy,
): Fact<K> {
  switch (settled._tag) {
    case "promoted":
      return {
        id: item.id,
        span: item.span,
        value: {
          _tag: "known",
          value: settled.judgement.label,
          basis: {
            _tag: "promoted",
            confidence: settled.judgement.confidence,
            floor: policy.floor,
            round: settled.round,
          },
        },
      };
    case "abstained":
      return { id: item.id, span: item.span, value: unknownValue("abstained") };
  }
}

export interface HumanQueueEntry<
  K extends string,
  J extends Judgement<K> = Judgement<K>,
> {
  readonly id: string;
  readonly span: SourceSpan;
  /** The last answer Jev gave, below the floor, for the human to confirm or overrule. */
  readonly answer: J;
  readonly rounds: number;
}

/** Every item a stage abstained on: the one place a human touches the pipeline. */
export interface HumanQueue<
  K extends string,
  J extends Judgement<K> = Judgement<K>,
> {
  readonly stage: string;
  readonly floor: number;
  readonly entries: readonly HumanQueueEntry<K, J>[];
}

export interface Gated<
  K extends string,
  J extends Judgement<K> = Judgement<K>,
> {
  readonly facts: readonly Fact<K>[];
  readonly queue: HumanQueue<K, J>;
  /** Where each item came to rest, in item order, with the whole answer the gate settled on. */
  readonly settled: readonly Settled<K, J>[];
}

/** Gate every item of one stage: facts for the next stage, abstentions for the human queue. */
export async function gateAll<
  K extends string,
  J extends Judgement<K> = Judgement<K>,
>(
  stage: string,
  items: readonly GateItem[],
  options: GateOptions<K, J>,
): Promise<Gated<K, J>> {
  const facts: Fact<K>[] = [];
  const entries: HumanQueueEntry<K, J>[] = [];
  const outcomes: Settled<K, J>[] = [];
  for (const item of items) {
    const settled = await gate(item, options);
    outcomes.push(settled);
    facts.push(factOf(item, settled, options.policy));
    if (settled._tag === "abstained")
      entries.push({
        id: item.id,
        span: item.span,
        answer: settled.judgement,
        rounds: settled.rounds,
      });
  }
  return {
    facts,
    queue: { stage, floor: options.policy.floor, entries },
    settled: outcomes,
  };
}
