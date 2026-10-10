// A private type: no entry publishes it, and `plain` reads it.
type Step = { readonly by: number };

/** Adds one, or `step.by`. */
export function plain(n: number, step?: Step): number {
  return n + (step?.by ?? 1);
}

export function over(a: string): string;
export function over(a: number): number;
export function over(a: string | number): string | number {
  return a;
}
