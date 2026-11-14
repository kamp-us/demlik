/**
 * Opens a log at a path.
 *
 * @stability stable
 * @category constructors
 */
export function open(path: string): string {
  return path;
}

/**
 * Closes the log.
 *
 * @stability stable
 * @category constructors
 */
export function close(): void {}

/**
 * The most lines a log keeps.
 *
 * @stability stable
 * @category constants
 */
export const LIMIT = 10;

/**
 * A log of lines.
 *
 * @stability stable
 * @category models
 */
export class Log {
  readonly lines: string[] = [];
}

/**
 * How loud a line is.
 *
 * @stability stable
 * @category models
 */
export enum Level {
  Low,
  High,
}

export function parse(input: string): number;
export function parse(input: number): string;
export function parse(input: string | number): string | number {
  return input;
}

/**
 * @stability stable
 * @category formatting
 */
export function format(value: number): string {
  return String(value);
}

/**
 * Runs a step again after it fails.
 *
 * @category combinators
 */
export function retry(step: () => void): void {
  step();
}

/**
 * Waits before the next step.
 *
 * @stability stable
 */
export function delay(ms: number): number {
  return ms;
}

/**
 * The version a log format first shipped in.
 *
 * @stability stable
 * @category constants
 * @since 1.0.0
 */
export const since = "1.0.0";

/**
 * Draws a sample line.
 *
 * @example sample()
 * @stability stable
 * @category constructors
 */
export function sample(): string {
  return "line";
}

/**
 * Swaps two lines.
 *
 * @category combinators
 * @stability stable
 */
export function swap(a: string, b: string): [string, string] {
  return [b, a];
}

/**
 * Describes a value two blocks sit above.
 *
 * @stability stable
 * @category constants
 */
/** @internal */
export const twoBlocks = 2;

/**
 * Reads a fenced sample, whose tag-like line is text.
 *
 * ```ts
 * @example fenced()
 * ```
 *
 * @stability stable
 * @category constructors
 */
export function fenced(): number {
  return 1;
}
