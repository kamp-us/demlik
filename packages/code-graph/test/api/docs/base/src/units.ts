/**
 * A length in meters.
 *
 * @stability stable
 * @category constructors
 */
export function meters(value: number): number {
  return value;
}

/**
 * A length in feet.
 *
 * @stability stable
 * @category constructors
 */
export function feet(value: number): number {
  return value * 0.3048;
}

/**
 * The unit a length is written in.
 *
 * @stability stable
 * @category models
 */
export type Unit = "m" | "ft";

export function convert(value: number, to: Unit): number {
  return to === "m" ? value : value / 0.3048;
}

/**
 * The digits a converted length keeps.
 *
 * @stability stable
 */
export const PRECISION = 3;

/**
 * Rounds a length to `PRECISION` digits.
 *
 * @stability stable
 * @category combinators
 */
export function round(value: number): number {
  return Number(value.toFixed(PRECISION));
}

/**
 * Lengths written out for people.
 *
 * @stability stable
 * @category namespaces
 */
export namespace Labels {
  /**
   * The long name of a unit.
   *
   * @stability stable
   * @category models
   */
  export type Long = "meters" | "feet";

  export function long(unit: Unit): Long {
    return unit === "m" ? "meters" : "feet";
  }
}
