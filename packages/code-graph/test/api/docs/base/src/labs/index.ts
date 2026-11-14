/**
 * Starts a trial.
 *
 * @stability experimental
 * @category constructors
 */
export function trial(): Trial {
  return { name: "trial" };
}

/**
 * One trial.
 *
 * @stability experimental
 * @category models
 */
export type Trial = { readonly name: string };

/**
 * Every trial that is running.
 *
 * @stability experimental
 * @category constants
 */
export const TRIALS: readonly Trial[] = [];

/**
 * An experiment over trials.
 *
 * @stability experimental
 * @category models
 */
export class Experiment {
  readonly trials = TRIALS;
}

export function probe(): boolean {
  return TRIALS.length > 0;
}

const pair = { alpha: 1, beta: 2 };

/**
 * The two arms of an experiment.
 *
 * @stability experimental
 * @category constants
 */
export const { alpha, beta } = pair;

/**
 * Drafts a trial that is not saved.
 *
 * @stability experimental
 * @category constructors
 */
// biome-ignore lint/suspicious/noExplicitAny: a line comment between the block and the export
export function draft(input: any): Trial {
  return { name: String(input) };
}

/**
 * The trial format before names.
 *
 * @deprecated use `Trial`
 * @stability experimental
 * @category models
 */
export type Legacy = { readonly id: number };
