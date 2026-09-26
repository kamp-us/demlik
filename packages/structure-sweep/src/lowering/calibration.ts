/** One answer scored against its gold label: what Jev said its confidence was, and whether it was right. */
export interface Scored {
  readonly confidence: number;
  readonly correct: boolean;
}

/** One equal-width confidence band, `[lower, upper)`, and how the answers that fell in it did. */
export interface Band {
  readonly lower: number;
  readonly upper: number;
  readonly n: number;
  /** Mean confidence of the band's answers. */
  readonly confidence: number;
  /** Share of the band's answers that matched the gold label. */
  readonly accuracy: number;
}

/** Refuse a bin count that cannot bin: a skipped answer would understate ECE, down to 0. */
export function assertBins(bins: number): void {
  if (!Number.isInteger(bins) || bins < 1)
    throw new RangeError(`bins is a positive whole number, not ${bins}`);
}

/** Refuse a confidence no band holds, rather than dropping the answer from the count. */
export function assertConfidence(confidence: number): void {
  if (!(confidence >= 0 && confidence <= 1))
    throw new RangeError(`a confidence is in [0, 1], not ${confidence}`);
}

/**
 * Every non-empty band, lowest first. A confidence of exactly 1 counts in the top band. Every answer
 * lands in exactly one band, so the bands' `n` sums to `answers.length`.
 */
export function confidenceBands(
  answers: readonly Scored[],
  bins = 10,
): readonly Band[] {
  assertBins(bins);
  const sums = Array.from({ length: bins }, () => ({
    n: 0,
    confidence: 0,
    correct: 0,
  }));
  for (const { confidence, correct } of answers) {
    assertConfidence(confidence);
    const sum = sums[Math.min(bins - 1, Math.floor(confidence * bins))];
    if (sum === undefined)
      throw new RangeError(`no band holds confidence ${confidence}`);
    sum.n += 1;
    sum.confidence += confidence;
    sum.correct += correct ? 1 : 0;
  }
  return sums.flatMap((s, i) =>
    s.n === 0
      ? []
      : [
          {
            lower: i / bins,
            upper: (i + 1) / bins,
            n: s.n,
            confidence: s.confidence / s.n,
            accuracy: s.correct / s.n,
          },
        ],
  );
}

/**
 * Expected calibration error: the gap between each band's mean confidence and its accuracy,
 * weighted by the band's share of answers.
 */
export function expectedCalibrationError(
  answers: readonly Scored[],
  bins = 10,
): number {
  const bands = confidenceBands(answers, bins);
  return bands.reduce(
    (ece, b) =>
      ece + (b.n / answers.length) * Math.abs(b.accuracy - b.confidence),
    0,
  );
}

declare const calibrated: unique symbol;

/**
 * A stage's floor, derived from its gold set: the lower edge of the lowest band such that it and
 * every non-empty band above it are at least `target` accurate. Built only by `calibrate`, so a
 * gate's floor is always one a gold set earned, never a number typed in.
 */
export interface DerivedFloor {
  readonly _tag: "derived";
  readonly target: number;
  readonly floor: number;
  readonly bands: readonly Band[];
  readonly [calibrated]: true;
}

/** No band reaches the target from the top down, so no answer from this stage can be promoted. */
export interface UnreachableFloor {
  readonly _tag: "unreachable";
  readonly target: number;
  readonly bands: readonly Band[];
}

export type Calibration = DerivedFloor | UnreachableFloor;

export interface CalibrateOptions {
  /** The accuracy every band at or above the floor must reach, in [0, 1]. */
  readonly target: number;
  readonly bins?: number;
}

/** Bin a stage's scored answers by confidence and derive the lowest floor whose bands meet `target`. */
export function calibrate(
  answers: readonly Scored[],
  options: CalibrateOptions,
): Calibration {
  const { target } = options;
  if (!(target >= 0 && target <= 1))
    throw new RangeError(`a target accuracy is in [0, 1], not ${target}`);
  const bands = confidenceBands(answers, options.bins);
  let floor: number | undefined;
  for (let i = bands.length - 1; i >= 0; i--) {
    const band = bands[i];
    if (band === undefined || band.accuracy < target) break;
    floor = band.lower;
  }
  return floor === undefined
    ? { _tag: "unreachable", target, bands }
    : ({ _tag: "derived", target, floor, bands } as DerivedFloor);
}
