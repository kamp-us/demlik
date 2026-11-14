/**
 * What `make` returns.
 *
 * @stability stable
 * @category models
 */
export type Maker = { readonly made: true };

export function make(): Maker {
  return { made: true };
}
