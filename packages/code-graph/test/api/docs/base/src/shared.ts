/**
 * What two subpaths share.
 *
 * @stability stable
 * @category models
 */
export interface Shared {
  readonly id: string;
}

export const sharedDefault: Shared = { id: "shared" };

/**
 * Two values side by side.
 *
 * @stability stable
 * @category models
 */
export type Pair<A, B> = readonly [A, B];

/**
 * Joins both halves of a pair.
 *
 * @stability stable
 * @since 1.2.0
 */
export function both<A, B>(pair: Pair<A, B>): string {
  return `${String(pair[0])}${String(pair[1])}`;
}
